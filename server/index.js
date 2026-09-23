import express from 'express'
import { db } from './db.js'
import { TYPES, ensureWeather, settleWeather, currentWeather } from './weather.js'
import {
  RECIPES, capacity, listJobs, queuedBatches,
  settleProduction, enqueueJob, cancelJob, collectJobs
} from './production.js'
import {
  COSTS as IRR_COSTS, RESERVOIR_CAP, networkInfo, computeNetworks, lastReport,
  settleIrrigation, buildFacility, toggleFacility, demolishFacility
} from './irrigation.js'
import {
  TRAITS, BREED_GOLD, breedCapacity,
  cropLike, listTrials, startTrial, careTrial, cancelTrial, settleBreeding
} from './breeding.js'

const app = express()
app.use(express.json())

// ===== 初始化种子数据（仅首次） =====
function seed() {
  const hasPlayer = db.prepare('SELECT COUNT(*) c FROM player').get().c
  if (hasPlayer > 0) return

  db.prepare('INSERT INTO player (id,name) VALUES (1,?)').run('小农夫')

  const crops = [
    ['萝卜', 3, 0, 8, 2, '🥕'],
    ['番茄', 5, 0, 15, 4, '🍅'],
    ['玉米', 6, 1, 20, 5, '🌽'],
    ['南瓜', 7, 2, 30, 8, '🎃'],
    ['小麦', 5, 0, 12, 3, '🌾'],
    ['白菜', 4, 2, 10, 3, '🥬']
  ]
  const cropIns = db.prepare('INSERT INTO crops VALUES (?,?,?,?,?,?,?)')
  crops.forEach((c, i) => cropIns.run(i + 1, ...c))

  // 初始 6x6 农田 + 出售地基信息见前端
  const plotIns = db.prepare('INSERT INTO plots (x,y) VALUES (?,?)')
  for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) plotIns.run(x, y)

  db.prepare('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)')
    .run('seed-1', '萝卜种子', 'seed', 10)
  db.prepare('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)')
    .run('gold_seed_5', '小麦种子', 'seed', 5)
  db.prepare('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)')
    .run('disaster-kit', '防灾物资', 'material', 3)

  const buildings = [
    ['农舍', 1, 0, 7, '你的家，升级可解锁新功能'],
    ['加工坊', 1, 7, 0, '将作物加工为制品出售'],
    ['畜棚', 1, 8, 7, '养殖动物，产出蛋奶毛'],
    ['市场', 1, 7, 6, '出售作物与制品'],
    ['育种棚', 1, 10, 7, '杂交育种：投入两批作物培育带遗传性状的新品种']
  ]
  const bIns = db.prepare('INSERT INTO buildings VALUES (?,?,?,?,?,?)')
  buildings.forEach((b, i) => bIns.run(i + 1, ...b))
}
seed()

// ===== 通用查询辅助 =====
const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 兼容旧存档：补插育种棚（新存档已在 seed() 中创建）
if (!q1('SELECT id FROM buildings WHERE name=?', '育种棚')) {
  run('INSERT INTO buildings (name,level,x,y,desc) VALUES (?,?,?,?,?)',
    '育种棚', 1, 10, 7, '杂交育种：投入两批作物培育带遗传性状的新品种')
}

// 启动时确保当天天气已生成（兼容旧存档）
const p0 = q1('SELECT * FROM player WHERE id=1')
ensureWeather(p0.season, p0.day, p0.abs_day)

// ===== API =====
app.get('/api/state', (req, res) => {
  const p = q1('SELECT * FROM player WHERE id=1')
  const mill = q1('SELECT * FROM buildings WHERE id=2')
  const lab = q1("SELECT * FROM buildings WHERE name='育种棚'")
  // 供水网络：连通且启用中的地块/水渠（前端绘制供水状态用）
  const nets = computeNetworks()
  const net = networkInfo(nets)
  res.json({
    player: p,
    crops: q('SELECT * FROM crops'),
    varieties: q('SELECT * FROM crop_varieties ORDER BY id')
      .map((v) => ({ ...v, traits: JSON.parse(v.traits || '[]') })),
    inventory: q('SELECT * FROM inventory'),
    buildings: q('SELECT * FROM buildings'),
    animals: q('SELECT * FROM animals'),
    plots: q('SELECT * FROM plots').map((pl) => ({ ...pl, irrigated: net.plotIds.has(pl.id) })),
    weather: currentWeather(),
    weatherLog: q('SELECT * FROM weather_log ORDER BY id DESC LIMIT 8'),
    recipes: RECIPES,
    queueCapacity: capacity(mill?.level || 1),
    queuedBatches: queuedBatches(p.abs_day),
    productionJobs: listJobs(p.abs_day),
    breeding: {
      trials: listTrials(),
      traits: TRAITS,
      capacity: breedCapacity(lab?.level || 1),
      running: q1("SELECT COUNT(*) c FROM breeding_trials WHERE status='running'").c,
      goldCost: BREED_GOLD,
      labId: lab?.id || null,
      labLevel: lab?.level || 1
    },
    irrigation: q('SELECT * FROM irrigation').map((f) => ({
      ...f,
      cap: f.kind === 'reservoir' ? RESERVOIR_CAP : null,
      linked: f.kind === 'canal' ? net.canalIds.has(f.id) : !!f.active
    })),
    irrigationCosts: IRR_COSTS,
    // 供水网络概览（多座蓄水池连通时统一分水）+ 最近一次每日分配结果（缺水时展示明细）
    irrigationNetworks: nets.filter((n) => n.reservoirs.length).map((n) => ({
      id: n.id, reservoirs: n.reservoirs.length, canals: n.canalIds.length,
      plots: n.plotIds.size, water: n.water, cap: n.cap
    })),
    irrigationReport: lastReport()
  })
})

// 播种：plotId + cropId（<1000 基础作物，>=1000 杂交品种）
app.post('/api/plant', (req, res) => {
  const { plotId, cropId } = req.body
  const plot = q1('SELECT * FROM plots WHERE id=?', plotId)
  const crop = cropLike(cropId)
  if (!plot || !crop) return res.status(404).json({ error: 'not found' })
  if (plot.crop_id) return res.status(400).json({ error: 'already planted' })
  const seedId = crop.isVariety ? 'seed-v' + crop.id : 'seed-' + crop.id
  const invById = q1("SELECT qty FROM inventory WHERE item_id=?", seedId)
  const stock = invById?.qty || 0
  if (stock <= 0) return res.status(400).json({ error: 'no seed' })
  run(`UPDATE plots SET crop_id=?, stage=0, water=100, fert=100, light=100, pest=0,
       planted_day=(SELECT day FROM player WHERE id=1), planted_season=(SELECT season FROM player WHERE id=1)
       WHERE id=?`, crop.id, plotId)
  run(`UPDATE inventory SET qty=qty-1 WHERE item_id=?`, seedId)
  cleanEmpty()
  res.json({ ok: true })
})

// 浇水
app.post('/api/water', (req, res) => {
  const { plotId } = req.body
  run('UPDATE plots SET water=100 WHERE id=?', plotId)
  res.json({ ok: true })
})

// 施肥
app.post('/api/fertilize', (req, res) => {
  const { plotId } = req.body
  run('UPDATE plots SET fert=100 WHERE id=?', plotId)
  res.json({ ok: true })
})

// 除草/除虫
app.post('/api/clean', (req, res) => {
  const { plotId } = req.body
  run('UPDATE plots SET pest=0 WHERE id=?', plotId)
  res.json({ ok: true })
})

// 收获：返回作物，给钱（若成熟）；品种按遗传性状结算产量与售价
app.post('/api/harvest', (req, res) => {
  const { plotId } = req.body
  const plot = q1('SELECT * FROM plots WHERE id=?', plotId)
  if (!plot || !plot.crop_id) return res.status(404).json({ error: 'empty' })
  const crop = cropLike(plot.crop_id)
  if (!crop) return res.status(404).json({ error: 'crop missing' })
  const isFullGrown = isCropGrown(plot, crop)
  if (isFullGrown) {
    // 产量：基础 1；高产 +1、低产 -1（保底 1）
    let yieldN = 1
    if (crop.isVariety) {
      for (const k of crop.traits) {
        const m = TRAITS[k]?.mods || {}
        if (m.harvestYield) yieldN += m.harvestYield
      }
    }
    yieldN = Math.max(1, yieldN)
    const gain = crop.price * yieldN
    run('UPDATE player SET gold=gold+?, exp=exp+? WHERE id=1', gain, 3)
    // 得到作物 + 概率得同种种子
    const cropItemId = crop.isVariety ? 'crop-v' + crop.id : 'crop-' + crop.id
    const seedItemId = crop.isVariety ? 'seed-v' + crop.id : 'seed-' + crop.id
    addInv(cropItemId, crop.name, 'crop', yieldN)
    if (Math.random() < 0.25) addInv(seedItemId, crop.name + '种子', 'seed', 1)
    run('UPDATE plots SET crop_id=NULL, stage=-1, water=100, fert=100, light=100, pest=0, planted_day=NULL, planted_season=NULL WHERE id=?', plotId)
    return res.json({ ok: true, yield: crop.name, qty: yieldN, gold: gain, variety: crop.isVariety })
  }
  return res.json({ ok: false, reason: 'not grown' })
})

// 时间推进 1 天
app.post('/api/nextday', (req, res) => {
  const logs = advanceDay()
  res.json({ ok: true, logs })
})

// 时间推进为主（快速）：连续跳日逐天结算天气防护消耗、损失与恢复
app.post('/api/skip', (req, res) => {
  const n = Math.min(Number(req.body?.n) || 1, 14)
  const logs = []
  for (let i = 0; i < n; i++) logs.push(...advanceDay())
  res.json({ ok: true, logs })
})

// 投入金币/物资防灾（作用于当前未结束的天气事件）
app.post('/api/weather/protect', (req, res) => {
  const gold = Math.max(0, Math.min(Math.floor(Number(req.body?.gold) || 0), 500))
  const matQty = Math.max(0, Math.min(Math.floor(Number(req.body?.matQty) || 0), 99))
  if (!gold && !matQty) return res.status(400).json({ error: '未投入任何资源' })
  const ev = q1('SELECT * FROM weather_events WHERE done=0 ORDER BY abs_day LIMIT 1')
  if (!ev || !TYPES[ev.type]?.bad) return res.status(400).json({ error: '当前天气无需防护' })
  db.exec('BEGIN IMMEDIATE')
  try {
    const p = q1('SELECT gold FROM player WHERE id=1')
    if (p.gold < gold) throw Object.assign(new Error('金币不足'), { status: 400 })
    if (matQty > 0) {
      const stacks = q("SELECT * FROM inventory WHERE cat='material' AND qty>0 ORDER BY qty DESC")
      const total = stacks.reduce((s, r) => s + r.qty, 0)
      if (total < matQty) throw Object.assign(new Error('物资不足'), { status: 400 })
      let need = matQty
      for (const s of stacks) {
        const take = Math.min(need, s.qty)
        run('UPDATE inventory SET qty=qty-? WHERE id=?', take, s.id)
        need -= take
        if (!need) break
      }
    }
    run('UPDATE player SET gold=gold-? WHERE id=1', gold)
    run('UPDATE weather_events SET protect_gold=protect_gold+?, protect_mat=protect_mat+? WHERE id=?', gold, matQty, ev.id)
    cleanEmpty()
    db.exec('COMMIT')
    res.json({ ok: true, protect_gold: ev.protect_gold + gold, protect_mat: ev.protect_mat + matQty })
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 购买防灾物资
app.post('/api/buymat', (req, res) => {
  const n = Math.max(1, Math.min(Number(req.body?.qty) || 1, 99))
  const cost = 12 * n
  const p = q1('SELECT gold FROM player WHERE id=1')
  if (p.gold < cost) return res.status(400).json({ error: 'no gold' })
  run('UPDATE player SET gold=gold-? WHERE id=1', cost)
  addInv('disaster-kit', '防灾物资', 'material', n)
  res.json({ ok: true })
})

// 买种子
app.post('/api/buyseed', (req, res) => {
  const { cropId, qty } = req.body
  const n = Math.max(1, Math.min(Number(qty) || 1, 99))
  const crop = q1('SELECT * FROM crops WHERE id=?', cropId)
  if (!crop) return res.status(404).json({ error: 'crop' })
  const cost = crop.seedPrice * n
  const p = q1('SELECT gold FROM player WHERE id=1')
  if (p.gold < cost) return res.status(400).json({ error: 'no gold' })
  run('UPDATE player SET gold=gold-? WHERE id=1', cost)
  addInv('seed-' + crop.id, crop.name + '种子', 'seed', n)
  res.json({ ok: true })
})

// 卖作物（兼容杂交品种：cropId>=1000 走品种库存与价格）
app.post('/api/sellcrop', (req, res) => {
  const { cropId, qty } = req.body
  const n = Math.max(1, Math.min(Number(qty) || 1, 999))
  const crop = cropLike(cropId)
  if (!crop) return res.status(404).json({ error: 'crop' })
  const itemId = crop.isVariety ? 'crop-v' + crop.id : 'crop-' + crop.id
  const hold = q1("SELECT qty FROM inventory WHERE item_id=?", itemId)
  const stock = hold?.qty || 0
  const s = Math.min(n, stock)
  if (s <= 0) return res.status(400).json({ error: 'none' })
  const gain = crop.price * s
  run(`UPDATE inventory SET qty=qty-? WHERE item_id=?`, s, itemId)
  run('UPDATE player SET gold=gold+? WHERE id=1', gain)
  cleanEmpty()
  res.json({ ok: true, gain, sold: s })
})

// 领养动物
app.post('/api/animal', (req, res) => {
  const { species } = req.body
  const cfg = { chicken: { name: '母鸡', cost: 30 }, cow: { name: '奶牛', cost: 80 }, sheep: { name: '绵羊', cost: 60 } }
  const c = cfg[species]
  if (!c) return res.status(400).json({ error: 'species' })
  const p = q1('SELECT gold FROM player WHERE id=1')
  if (p.gold < c.cost) return res.status(400).json({ error: 'no gold' })
  run('UPDATE player SET gold=gold-? WHERE id=1', c.cost)
  const x = 8 + (q('SELECT COUNT(*) c FROM animals').length) % 3
  const r = run('INSERT INTO animals (name,species,x,y) VALUES (?,?,?,?)', c.name + '#' + (Date.now() % 1000), species, x, 8)
  res.json({ ok: true, id: r.lastInsertRowid })
})

// 喂食
app.post('/api/feed', (req, res) => {
  const { id } = req.body
  run('UPDATE animals SET feed=100 WHERE id=?', id)
  res.json({ ok: true })
})

// 收集动物产物
app.post('/api/collect', (req, res) => {
  const { id } = req.body
  const a = q1('SELECT * FROM animals WHERE id=?', id)
  if (!a || !a.ready) return res.status(400).json({ error: 'not ready' })
  const prod = { chicken: ['鸡蛋', 6], cow: ['牛奶', 12], sheep: ['羊毛', 10] }[a.species]
  addInv('p-' + a.species, prod[0], 'product', 1)
  const gain = Math.round(prod[1] / 2)
  run('UPDATE player SET gold=gold+? WHERE id=1', gain)
  run('UPDATE animals SET ready=0 WHERE id=?', id)
  res.json({ ok: true, item: prod[0], gold: gain })
})

// ===== 加工生产队列 =====
// 批量排产：recipeId + qty（批次数）
app.post('/api/production/enqueue', (req, res) => {
  try {
    const { recipeId, qty } = req.body
    const p = q1('SELECT * FROM player WHERE id=1')
    const mill = q1('SELECT level FROM buildings WHERE id=2')
    const r = enqueueJob({
      recipeId,
      qty: Number(qty) || 1,
      millLevel: mill?.level || 1,
      currentAbs: p.abs_day
    })
    res.json(r)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 取消工单：退未开工批次的原料
app.post('/api/production/cancel', (req, res) => {
  try {
    const p = q1('SELECT abs_day FROM player WHERE id=1')
    const r = cancelJob({ id: Number(req.body?.id), currentAbs: p.abs_day })
    res.json(r)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 完工入库：传 id 领单个，不传则一键全领
app.post('/api/production/collect', (req, res) => {
  try {
    const p = q1('SELECT abs_day FROM player WHERE id=1')
    const r = collectJobs(p.abs_day, req.body?.id != null ? Number(req.body.id) : null)
    res.json(r)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// ===== 灌溉系统 =====
// 建造蓄水池/水渠：kind + 坐标，扣金币
app.post('/api/irrigation/build', (req, res) => {
  try {
    const { kind, x, y } = req.body || {}
    res.json(buildFacility(kind, Number(x), Number(y)))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 停用/启用：停用即断流，启用后恢复供水
app.post('/api/irrigation/toggle', (req, res) => {
  try {
    res.json(toggleFacility(Number(req.body?.id)))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 拆除：返还部分造价，蓄水池余水作废
app.post('/api/irrigation/demolish', (req, res) => {
  try {
    res.json(demolishFacility(Number(req.body?.id)))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 设置地块灌溉优先级（0低 1中 2高）
app.post('/api/irrigation/priority', (req, res) => {
  const plotId = Number(req.body?.plotId)
  const priority = Math.max(0, Math.min(2, Math.floor(Number(req.body?.priority) || 0)))
  if (!q1('SELECT id FROM plots WHERE id=?', plotId)) return res.status(404).json({ error: 'not found' })
  run('UPDATE plots SET irr_priority=? WHERE id=?', priority, plotId)
  res.json({ ok: true, priority })
})

// 设置地块目标水分（0~100，灌溉时浇到该水位为止；0 表示不自动浇水）
app.post('/api/irrigation/target', (req, res) => {
  const plotId = Number(req.body?.plotId)
  const target = Math.max(0, Math.min(100, Math.floor(Number(req.body?.target) || 0)))
  if (!q1('SELECT id FROM plots WHERE id=?', plotId)) return res.status(404).json({ error: 'not found' })
  run('UPDATE plots SET irr_target=? WHERE id=?', target, plotId)
  res.json({ ok: true, target })
})

// ===== 杂交育种 =====
// 开始试验：两批作物 parentA/parentB，格式 base:<id> 或 var:<id>
app.post('/api/breeding/start', (req, res) => {
  try {
    const lab = q1("SELECT level FROM buildings WHERE name='育种棚'")
    const p = q1('SELECT abs_day FROM player WHERE id=1')
    const r = startTrial({
      parentA: String(req.body?.parentA || ''),
      parentB: String(req.body?.parentB || ''),
      labLevel: lab?.level || 1,
      currentAbs: p.abs_day
    })
    res.json(r)
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 养护试验：water 浇水 / fert 施肥 / tend 照料
app.post('/api/breeding/care', (req, res) => {
  try {
    res.json(careTrial(Number(req.body?.id), String(req.body?.action || '')))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 取消试验（亲本不退）
app.post('/api/breeding/cancel', (req, res) => {
  try {
    res.json(cancelTrial(Number(req.body?.id)))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 升级建筑
app.post('/api/upgrade', (req, res) => {
  const { id } = req.body
  const b = q1('SELECT * FROM buildings WHERE id=?', id)
  if (!b || b.level >= 5) return res.status(400).json({ error: 'max' })
  const cost = 40 * b.level
  if (q1('SELECT gold FROM player WHERE id=1').gold < cost) return res.status(400).json({ error: 'no gold' })
  run('UPDATE player SET gold=gold-? WHERE id=1', cost)
  run('UPDATE buildings SET level=level+1 WHERE id=?', id)
  res.json({ ok: true, level: b.level + 1 })
})

// ===== 工具函数 =====
function addInv(itemId, name, cat, n) {
  const row = q1('SELECT qty FROM inventory WHERE item_id=?', itemId)
  if (row) run('UPDATE inventory SET qty=qty+? WHERE item_id=?', n, itemId)
  else run('INSERT INTO inventory (item_id,name,cat,qty) VALUES (?,?,?,?)', itemId, name, cat, n)
}
function cleanEmpty() {
  db.exec('DELETE FROM inventory WHERE qty<=0')
}
function isCropGrown(plot, crop) {
  return plot.stage >= (crop.days - 1)
}
function clamp100(v) { return Math.max(0, Math.min(100, v)) }
// 推进 1 天：事务内完成「天气结算 → 地块/动物逐日更新 → 日期推进 → 生成次日天气」，
// 任一步失败整体回滚，读档或重试不会重复扣损。返回当日天气结算日志。
function advanceDay() {
  const logs = []
  db.exec('BEGIN IMMEDIATE')
  try {
    const p = q1('SELECT * FROM player WHERE id=1')
    let { day, season } = p
    // —— 天气：结算当日事件（防护消耗/损失/恢复按天结算，幂等）——
    const { mods, logs: wlogs, type: wType, severity: wSev } = settleWeather(p.abs_day)
    logs.push(...wlogs)
    day += 1
    // 更新所有地块：生长 + 四维变化 + 虫害 + 天气修正（杂交品种性状参与结算）
    const plots = q('SELECT * FROM plots')
    for (const pl of plots) {
      if (!pl.crop_id) continue
      const crop = cropLike(pl.crop_id)
      if (!crop) continue
      const tset = new Set(crop.isVariety ? crop.traits : [])
      const traitMul = (k, f) => (tset.has(k) ? f : 1)
      // 四维消耗 + 天气修正（性状：抗旱减半耗水、脆弱放大天气损耗）
      const waterDecayMul = (tset.has('droughthardy') ? 0.5 : 1) * traitMul('weak', (TRAITS.weak.mods.weatherMul))
      const weatherMul = traitMul('weak', TRAITS.weak.mods.weatherMul)
      let water = pl.water - (12 + Math.round(Math.random() * 12)) * waterDecayMul
        + (mods.waterAdd || 0) * weatherMul
      let fert = pl.fert - (8 + Math.round(Math.random() * 8)) + (mods.fertAdd || 0) * weatherMul
      let light = pl.light - (6 + Math.round(Math.random() * 8)) + (mods.lightAdd || 0) * weatherMul + mods.lightRecover
      // 季节光照影响
      if (season === 3) light -= 10
      // 降雨/暴雨直接灌满
      if (mods.setWater != null) water = mods.setWater
      water = clamp100(water); fert = clamp100(fert); light = clamp100(light)
      // 虫害：抗虫品种自然生虫率大减
      const pestChance = 0.25 * (tset.has('pestresist') ? (TRAITS.pestresist.mods.pestChanceMul) : 1)
      let pest = Math.max(0, pl.pest + (Math.random() < pestChance ? 1 : 0) + (mods.pestAdd || 0) * weatherMul)
      // 虫害过高会降低属性；恶劣天气可能阻止生长（抗寒/抗旱品种可抵抗对应停长）
      let blocked = !!mods.growthBlock
      if (blocked) {
        if (tset.has('frosthardy') && ['frost', 'freeze', 'blizzard'].includes(wType)) blocked = false
        if (tset.has('droughthardy') && wType === 'drought') blocked = false
      }
      const flux = water >= 30 && fert >= 30 && light >= 30 && pest <= 0.6 && !blocked
      const full = pl.stage >= (crop.days - 1)
      let stage = pl.stage
      if (!full && flux) {
        stage += 1
        // 速生：条件良好时一天长两阶
        if (tset.has('fastgrow') && Math.random() < TRAITS.fastgrow.mods.bonusGrowChance) {
          stage = Math.min(crop.days - 1, stage + 1)
        }
      }
      // 恶劣天气可能打坏作物（倒退一阶段）
      if (stage > 0 && mods.stageRegressChance > 0 && Math.random() < mods.stageRegressChance) stage -= 1
      run(`UPDATE plots SET water=?,fert=?,light=?,pest=?,stage=? WHERE id=?`, water, fert, light, pest, stage, pl.id)
    }
    // 动物喂食衰减 + 天气伤害/恢复 + 产物就绪
    const animals = q('SELECT * FROM animals')
    for (const a of animals) {
      const feed = Math.max(0, a.feed - 25)
      let health = a.health - (feed === 0 ? 20 : 6) + mods.animalHpAdd
      if (feed > 0) health += mods.animalRecover
      health = Math.max(0, Math.min(100, health))
      run(`UPDATE animals SET feed=?,health=?,ready=1 WHERE id=?`, feed, health, a.id)
    }
    // —— 灌溉：降雨补水/干旱耗水，连通网络内多池统一分水（结合天气与品种耗水调度）——
    logs.push(...settleIrrigation({ type: wType, severity: wSev, mods }, p.abs_day))
    // —— 育种：试验随天推进，受养护（水分/肥力/照料）与天气影响，成熟产出新品种种子 ——
    logs.push(...settleBreeding({ type: wType, severity: wSev, mods }, p.abs_day + 1))
    // 天数推进与季节轮转
    if (day > 28) {
      day = 1
      season = (season + 1) % 4
    }
    run('UPDATE player SET day=?, season=?, abs_day=abs_day+1 WHERE id=1', day, season)
    // —— 加工队列：按游戏天推进，完工批次落库（与天气/作物同一事务，失败整体回滚）——
    const plogs = settleProduction(p.abs_day + 1)
    logs.push(...plogs)
    // 生成次日天气（持续中的事件会自然延续）
    ensureWeather(season, day, p.abs_day + 1)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
  return logs
}

const PORT = 4110
app.listen(PORT, () => console.log(`[FARM] API running at http://localhost:${PORT}`))