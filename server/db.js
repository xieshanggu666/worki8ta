import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'farm.db'))

// 启用基本约束
db.exec('PRAGMA foreign_keys = ON;')

// 建表
db.exec(`
CREATE TABLE IF NOT EXISTS player (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  gold INTEGER NOT NULL DEFAULT 100,
  level INTEGER NOT NULL DEFAULT 1,
  exp INTEGER NOT NULL DEFAULT 0,
  season INTEGER NOT NULL DEFAULT 0,      -- 0春 1夏 2秋 3冬
  day INTEGER NOT NULL DEFAULT 1,
  hour INTEGER NOT NULL DEFAULT 8
);

CREATE TABLE IF NOT EXISTS plots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  crop_id INTEGER DEFAULT NULL,           -- 关联 crops.id
  stage INTEGER NOT NULL DEFAULT -1,      -- -1 空地 0播种 1..n-1生长 n成熟
  water INTEGER NOT NULL DEFAULT 100,
  fert INTEGER NOT NULL DEFAULT 100,
  light INTEGER NOT NULL DEFAULT 100,
  pest INTEGER NOT NULL DEFAULT 0,        -- 0无 越高越差
  planted_day INTEGER,
  planted_season INTEGER
);

CREATE TABLE IF NOT EXISTS crops (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  days INTEGER NOT NULL,
  season INTEGER NOT NULL,               -- 适宜季节
  price INTEGER NOT NULL,
  seedPrice INTEGER NOT NULL,
  sprite TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cat TEXT NOT NULL,                     -- seed/crop/product/material/animal/other
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS buildings (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  desc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS animals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  species TEXT NOT NULL,                 -- chicken/cow/sheep
  feed INTEGER NOT NULL DEFAULT 100,
  health INTEGER NOT NULL DEFAULT 100,
  ready INTEGER NOT NULL DEFAULT 0,      -- 可收集产物 0/1
  x INTEGER NOT NULL,
  y INTEGER NOT NULL
);

-- 天气事件：按季节生成并持久化；防护投入与结算进度都落库
CREATE TABLE IF NOT EXISTS weather_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  day INTEGER NOT NULL,                  -- 季节内第几天（事件开始日）
  abs_day INTEGER NOT NULL,              -- 绝对天数（全局递增，结算对齐用）
  type TEXT NOT NULL,                    -- sunny/rain/drought/storm/frost/heatwave/blizzard/freeze/wind
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 1,   -- 持续天数
  severity INTEGER NOT NULL DEFAULT 0,   -- 0 无害 / 1~3 灾害等级
  protect_gold INTEGER NOT NULL DEFAULT 0,  -- 已投入防护金币储备
  protect_mat INTEGER NOT NULL DEFAULT 0,   -- 已投入防护物资储备
  settled_days INTEGER NOT NULL DEFAULT 0,  -- 已结算天数（防重复扣损）
  done INTEGER NOT NULL DEFAULT 0
);

-- 天气逐日结算日志：UNIQUE(event_id, abs_day) 保证同一天只结算一次
CREATE TABLE IF NOT EXISTS weather_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  abs_day INTEGER NOT NULL,
  msg TEXT NOT NULL,
  UNIQUE(event_id, abs_day)
);

-- 灌溉设施：蓄水池(reservoir)储水，水渠(canal)连接蓄水池与地块；
-- 停用(active=0)即断流，重新启用自动恢复供水；拆除直接删行
CREATE TABLE IF NOT EXISTS irrigation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- reservoir/canal
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  water INTEGER NOT NULL DEFAULT 0,   -- 蓄水池当前水量（水渠恒为 0）
  UNIQUE(x, y)
);

-- 灌溉每日分配结果：按绝对天唯一（同日重算覆盖），缺水时前端展示逐地块明细
CREATE TABLE IF NOT EXISTS irrigation_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  abs_day INTEGER NOT NULL UNIQUE,
  detail TEXT NOT NULL            -- JSON：各供水网络的池水变化与逐地块分配
);

-- 加工生产工单：批量排产，按游戏天串行推进；取消时记录取消绝对日用于退料与队列重排
CREATE TABLE IF NOT EXISTS production_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id TEXT NOT NULL,              -- 配方 id（见 server/production.js RECIPES）
  recipe_name TEXT NOT NULL,
  result_id TEXT NOT NULL,
  result_name TEXT NOT NULL,
  result_cat TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_cat TEXT NOT NULL,
  consume INTEGER NOT NULL,             -- 每批消耗原料数
  gain INTEGER NOT NULL,                -- 每批产出成品数
  days INTEGER NOT NULL,                -- 每批耗时（游戏天）
  qty INTEGER NOT NULL,                 -- 批次数
  finished INTEGER NOT NULL DEFAULT 0,  -- 已完工批次数（跨天结算时落库）
  enqueue_abs INTEGER NOT NULL,         -- 排产时的绝对天
  cancel_abs INTEGER DEFAULT NULL,      -- 取消时的绝对天（NULL 未取消）
  status TEXT NOT NULL DEFAULT 'running' -- running/done/canceled/collected
);

-- ===== 杂交育种 =====
-- 杂交新品种（遗传性状作物）：id 从 1000 起，与 crops 表基础作物共存；
-- plots.crop_id 既可能指向基础作物（<1000）也可能指向品种（>=1000）。
-- sig = 本源作物 + 排序后性状，保证同一品种重复育成时复用而非重复建行。
CREATE TABLE IF NOT EXISTS crop_varieties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_id INTEGER NOT NULL,             -- 本源基础作物 crops.id
  name TEXT NOT NULL UNIQUE,
  sprite TEXT NOT NULL,
  season INTEGER NOT NULL,              -- 适宜季节（随本源）
  days INTEGER NOT NULL,                -- 成熟期（性状已折算）
  price INTEGER NOT NULL,               -- 售价（性状已折算）
  seed_price INTEGER NOT NULL,
  traits TEXT NOT NULL DEFAULT '[]',    -- 遗传性状 key 数组（JSON）
  sig TEXT NOT NULL UNIQUE,
  parent_a TEXT NOT NULL,               -- 父本引用：base:<id> / var:<id>
  parent_b TEXT NOT NULL,               -- 母本引用
  gen INTEGER NOT NULL DEFAULT 1,       -- 谱系代数（基础作物为 0）
  created_abs INTEGER NOT NULL
);

-- 育种试验：投入两批作物，随游戏天推进，受养护与天气影响，成熟产出带遗传性状的种子
CREATE TABLE IF NOT EXISTS breeding_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_a TEXT NOT NULL,
  parent_b TEXT NOT NULL,
  parent_a_name TEXT NOT NULL,
  parent_a_icon TEXT NOT NULL,
  parent_a_traits TEXT NOT NULL DEFAULT '[]',
  parent_b_name TEXT NOT NULL,
  parent_b_icon TEXT NOT NULL,
  parent_b_traits TEXT NOT NULL DEFAULT '[]',
  base_id INTEGER NOT NULL,             -- 子代本源作物（跨种杂交时随机取亲本之一）
  traits_json TEXT NOT NULL DEFAULT '[]', -- 授粉时即确定的子代性状（影响试验与后续种植）
  status TEXT NOT NULL DEFAULT 'running', -- running/done/failed/canceled
  progress INTEGER NOT NULL DEFAULT 0,  -- 已发育天数（达标即成熟）
  days_total INTEGER NOT NULL DEFAULT 4,
  water INTEGER NOT NULL DEFAULT 75,    -- 试验田水分（浇水养护）
  fert INTEGER NOT NULL DEFAULT 75,     -- 肥力（施肥养护）
  health INTEGER NOT NULL DEFAULT 100,  -- 健康度（恶劣天气下降，照料恢复；归零试验失败）
  care INTEGER NOT NULL DEFAULT 0,      -- 养护累计分 0~100（决定产出种子数）
  care_count INTEGER NOT NULL DEFAULT 0,
  blocked_days INTEGER NOT NULL DEFAULT 0, -- 受阻天数（条件不良/灾害停长）
  result_variety_id INTEGER,
  result_seeds INTEGER NOT NULL DEFAULT 0,
  start_abs INTEGER NOT NULL,
  finish_abs INTEGER
);
`)

// 兼容旧存档：player 增加绝对天数（天气结算对齐用）
const playerCols = db.prepare('PRAGMA table_info(player)').all().map((c) => c.name)
if (!playerCols.includes('abs_day')) {
  db.exec('ALTER TABLE player ADD COLUMN abs_day INTEGER NOT NULL DEFAULT 1')
}

// 杂交品种 id 从 1000 起，避免与基础作物 crops.id（1..n）冲突；
// sqlite_sequence 已存在更高值时该设置不会回退
db.exec("INSERT OR IGNORE INTO sqlite_sequence(name,seq) VALUES('crop_varieties',999)")

// 兼容旧存档：plots 增加灌溉优先级（0低 1中 2高，水量不足时高优先级先供水）
const plotCols = db.prepare('PRAGMA table_info(plots)').all().map((c) => c.name)
if (!plotCols.includes('irr_priority')) {
  db.exec('ALTER TABLE plots ADD COLUMN irr_priority INTEGER NOT NULL DEFAULT 1')
}

// 兼容旧存档：plots 增加目标水分（灌溉时浇到该水位为止；0 表示不自动浇水，默认 100 与旧行为一致）
if (!plotCols.includes('irr_target')) {
  db.exec('ALTER TABLE plots ADD COLUMN irr_target INTEGER NOT NULL DEFAULT 100')
}