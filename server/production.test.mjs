import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

// 用临时数据库，避免污染正式存档；必须在 import 任何服务端模块前设置
const tmpDb = path.join(os.tmpdir(), `farm-test-production-${process.pid}.db`)
fs.rmSync(tmpDb, { force: true })
process.env.FARM_DB_PATH = tmpDb

let mod
before(async () => {
  mod = await import('./production.js')
})

function stock(db, itemId) {
  return db.prepare('SELECT qty FROM inventory WHERE item_id=?').get(itemId)?.qty || 0
}
function give(db, itemId, name, cat, qty) {
  db.prepare('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)').run(itemId, name, cat, qty)
}

test('排产记录逐批投料，取消时按实际来源退回杂交作物', () => {
  const { db, enqueueJob, cancelJob } = mod
  // 小麦配方 consume=2/批。库存：基础小麦 2，同本源杂交「黄金小麦」10（共 12，两单各 6）
  db.exec('DELETE FROM inventory')
  db.exec('DELETE FROM production_inputs')
  db.exec('DELETE FROM production_jobs')
  db.prepare('INSERT OR REPLACE INTO crop_varieties (id,base_id,name,sprite,season,days,price,seed_price,traits,sig,parent_a,parent_b,gen,created_abs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(1000, 5, '黄金小麦', '🌾', 0, 3, 60, 30, '["high_yield"]', 'sig-gold-wheat', 'base:5', 'base:5', 1, 1)
  give(db, 'crop-5', '小麦', 'crop', 2)
  give(db, 'crop-v1000', '黄金小麦', 'crop', 10)

  // lv2 容量 6：两单各 3 批（共需 12 个小麦）
  const j1 = enqueueJob({ recipeId: 'flour', qty: 3, millLevel: 2, currentAbs: 1 }).id
  const j2 = enqueueJob({ recipeId: 'flour', qty: 3, millLevel: 2, currentAbs: 1 }).id

  // 投料顺序：基础先扣（2 个 → 首批），杂交补后 10 个（第 2、3 批 + 工单2 全部 3 批）
  const rows = db.prepare('SELECT batch,item_id,qty FROM production_inputs WHERE job_id=? ORDER BY id').all(j1)
    .map((r) => ({ batch: r.batch, item_id: r.item_id, qty: r.qty }))
  assert.deepEqual(rows, [
    { batch: 0, item_id: 'crop-5', qty: 2 },
    { batch: 1, item_id: 'crop-v1000', qty: 2 },
    { batch: 2, item_id: 'crop-v1000', qty: 2 }
  ])

  // 工单2 排在 3 天后才开工（days=1），第 1 天立即取消：整单未开工，6 个杂交小麦必须原样退回
  let r = cancelJob({ id: j2, currentAbs: 1 })
  assert.equal(r.refundBatches, 3)
  assert.equal(stock(db, 'crop-v1000'), 6, '杂交作物应原样退回，不能退成基础作物')
  assert.equal(stock(db, 'crop-5'), 0)
  const byItem = Object.fromEntries(r.refunds.map((x) => [x.itemId, x.qty]))
  assert.deepEqual(byItem, { 'crop-v1000': 6 })

  // 工单1：推进到第 2 天（首批已完工、次批开工），取消时只退第 3 批（杂交小麦 ×2）
  r = cancelJob({ id: j1, currentAbs: 2 })
  assert.equal(r.refundBatches, 1)
  assert.equal(stock(db, 'crop-v1000'), 8)
  assert.equal(stock(db, 'crop-5'), 0, '前两批已开工/完工，基础小麦不退')
})

test('非作物配方取消时退回原物品（牛奶）', () => {
  const { db, enqueueJob, cancelJob } = mod
  db.exec('DELETE FROM inventory')
  db.exec('DELETE FROM production_inputs')
  db.exec('DELETE FROM production_jobs')
  give(db, 'p-cow', '牛奶', 'product', 4)
  // cheese days=2/批，2 批：首批当天开工，当天取消只退第 2 批
  const id = enqueueJob({ recipeId: 'cheese', qty: 2, millLevel: 2, currentAbs: 1 }).id
  const r = cancelJob({ id, currentAbs: 1 })
  assert.equal(r.refundBatches, 1)
  assert.equal(stock(db, 'p-cow'), 2)
  assert.equal(r.refunds[0].itemId, 'p-cow')
})

test('旧存档工单没有投料明细时，取消回退为退配方登记的原料', () => {
  const { db, cancelJob } = mod
  db.exec('DELETE FROM inventory')
  db.exec('DELETE FROM production_inputs')
  db.exec('DELETE FROM production_jobs')
  // 先用一个 3 天/批的工单占住机器，保证插入的旧工单当天还没开工
  db.prepare(`INSERT INTO production_jobs
    (recipe_id,recipe_name,result_id,result_name,result_cat,from_id,from_name,from_cat,
     consume,gain,days,qty,finished,enqueue_abs,status)
    VALUES ('bread','面包','bread','面包','product','flour','面粉','material',2,1,3,1,0,1,'running')`).run()
  // 旧版小麦工单：production_inputs 里没有任何明细
  const old = db.prepare(`INSERT INTO production_jobs
    (recipe_id,recipe_name,result_id,result_name,result_cat,from_id,from_name,from_cat,
     consume,gain,days,qty,finished,enqueue_abs,status)
    VALUES ('flour','面粉','flour','面粉','material','crop-5','小麦','crop',2,1,1,2,0,1,'running')`)
    .run().lastInsertRowid
  const r = cancelJob({ id: old, currentAbs: 1 })
  assert.equal(r.refundBatches, 2)
  assert.equal(stock(db, 'crop-5'), 4, '旧工单按工单登记的基础作物退回')
  assert.deepEqual(r.refunds.map((x) => x.itemId), ['crop-5'])

  fs.rmSync(tmpDb, { force: true })
})
