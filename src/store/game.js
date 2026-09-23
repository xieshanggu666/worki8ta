import { defineStore } from 'pinia'

async function api(path, method = 'GET', body) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch('/api' + path, opt)
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || '请求失败')
  return data
}

export const useGameStore = defineStore('game', {
  state: () => ({
    loaded: false,
    player: null,
    crops: [],
    varieties: [],
    inventory: [],
    buildings: [],
    animals: [],
    plots: [],
    weather: null,
    weatherLog: [],
    recipes: [],
    productionJobs: [],
    queueCapacity: 0,
    queuedBatches: 0,
    breeding: null,
    irrigation: [],
    irrigationCosts: { reservoir: 60, canal: 8 },
    irrigationNetworks: [],  // 供水网络概览（多池连通统一分水）
    irrigationReport: null,  // 最近一次每日供水分配结果（缺水时展示明细）
    irrBuildMode: null,      // 'reservoir' | 'canal' | null：地图放置模式
    selectedPlot: null,
    seedMode: false,
    selectedCropId: null,
    toast: null,
    timeline: []
  }),
  getters: {
    seasonLabel: (s) => {
      const map = ['🌸 春', '☀️ 夏', '🍂 秋', '❄️ 冬']
      return s.player ? map[s.player.season % 4] : '🌸 春'
    },
    currentSeason: (s) => s.player?.season ?? 0,
    // 统一作物表：基础作物 + 杂交品种（id 均唯一）
    allCrops: (s) => {
      const vars = (s.varieties || []).map((v) => ({
        id: v.id, name: v.name, days: v.days, season: v.season,
        price: v.price, seedPrice: v.seed_price, sprite: v.sprite,
        traits: v.traits || [], gen: v.gen, base_id: v.base_id, isVariety: true
      }))
      return [...s.crops.map((c) => ({ ...c, traits: [], gen: 0, base_id: c.id, isVariety: false })), ...vars]
    }
  },
  actions: {
    async load() {
      const d = await api('/state')
      this.player = d.player
      this.crops = d.crops
      this.varieties = d.varieties || []
      this.inventory = d.inventory
      this.buildings = d.buildings
      this.animals = d.animals
      this.plots = d.plots
      this.weather = d.weather
      this.weatherLog = d.weatherLog || []
      this.recipes = d.recipes || []
      this.productionJobs = d.productionJobs || []
      this.queueCapacity = d.queueCapacity || 0
      this.queuedBatches = d.queuedBatches || 0
      this.breeding = d.breeding || null
      this.irrigation = d.irrigation || []
      this.irrigationCosts = d.irrigationCosts || this.irrigationCosts
      this.irrigationNetworks = d.irrigationNetworks || []
      this.irrigationReport = d.irrigationReport || null
      this.loaded = true
    },
    pushLog(msg, type = 'info') {
      this.timeline.unshift({ msg, type, time: new Date().toLocaleTimeString('zh-CN') })
      if (this.timeline.length > 30) this.timeline.pop()
    },
    showToast(msg, type = 'info') {
      this.toast = { msg, type, id: Date.now() }
      this.pushLog(msg, type)
    },
    clearToast() { this.toast = null },

    async refresh() { await this.load() },

    async plant() {
      if (!this.selectedPlot || !this.selectedCropId) return
      try {
        await api('/plant', 'POST', { plotId: this.selectedPlot.id, cropId: this.selectedCropId })
        await this.load()
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async water() {
      if (!this.selectedPlot) return
      await api('/water', 'POST', { plotId: this.selectedPlot.id })
      await this.load()
    },
    async fertilize() {
      if (!this.selectedPlot) return
      await api('/fertilize', 'POST', { plotId: this.selectedPlot.id })
      await this.load()
    },
    async clean() {
      if (!this.selectedPlot) return
      await api('/clean', 'POST', { plotId: this.selectedPlot.id })
      await this.load()
    },
    async harvest() {
      if (!this.selectedPlot) return
      const r = await api('/harvest', 'POST', { plotId: this.selectedPlot.id })
      if (r.ok) this.showToast(`收获 ${r.yield} ×${r.qty || 1} +${r.gold}金${r.variety ? '🧬' : ''}`, 'success')
      else this.showToast('作物还未成熟', 'warn')
      await this.load()
    },
    async nextDay(n = 1) {
      const r = await api('/skip', 'POST', { n })
      await this.load()
      const logs = r.logs || []
      // 天气/系统结算记录只进时间线，不弹 toast；加工完工与育种成功取第一条弹提示
      logs.forEach((m) => { if (!m.startsWith('✅') && !m.startsWith('🧬')) this.pushLog(m, 'warn') })
      const done = logs.filter((m) => m.startsWith('✅') || m.startsWith('🧬'))
      if (done.length) this.showToast(done[0], 'success')
      else this.showToast(`时间 +${n} 天`, 'info')
    },
    async protect(gold, matQty) {
      try {
        await api('/weather/protect', 'POST', { gold, matQty })
        await this.load()
        this.showToast('已投入防护资源', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async buyMat(qty = 1) {
      try {
        await api('/buymat', 'POST', { qty })
        await this.load()
        this.showToast('已购入防灾物资', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async buySeed(cropId, qty = 1) {
      try {
        await api('/buyseed', 'POST', { cropId, qty })
        await this.load()
        this.showToast('已购买种子', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async sellCrop(cropId, qty = 1) {
      try {
        const r = await api('/sellcrop', 'POST', { cropId, qty })
        await this.load()
        this.showToast(`售出${r.sold}，+${r.gain}金`, 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async buyAnimal(species) {
      try {
        await api('/animal', 'POST', { species })
        await this.load()
        this.showToast('已领养', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async feedAnimal(id) {
      await api('/feed', 'POST', { id })
      await this.load()
    },
    async collectAnimal(id) {
      try {
        const r = await api('/collect', 'POST', { id })
        await this.load()
        this.showToast(`收集 ${r.item} +${r.gold}金`, 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    // 批量排产
    async enqueueProduction(recipeId, qty) {
      try {
        await api('/production/enqueue', 'POST', { recipeId, qty })
        await this.load()
        this.showToast(`已排产 ${qty} 批，开工后按天自动推进`, 'success')
      } catch (e) { this.showToast(e.message, 'warn'); throw e }
    },
    // 取消工单（退未开工批次的原料）
    async cancelProduction(id) {
      try {
        const r = await api('/production/cancel', 'POST', { id })
        await this.load()
        if (r.refundBatches > 0) this.showToast(`已取消，退回 ${r.refundBatches} 批原料`, 'info')
        else this.showToast('已取消（无未开工批次可退料）', 'info')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    // 完工入库：传 id 领单个，不传一键全领
    async collectProduction(id = null) {
      try {
        const r = await api('/production/collect', 'POST', id == null ? {} : { id })
        await this.load()
        const text = r.picked.map((p) => `${p.name}×${p.qty}`).join('、')
        this.showToast(`完工入库：${text}`, 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async upgradeBuilding(id) {
      try {
        await api('/upgrade', 'POST', { id })
        await this.load()
        this.showToast('建筑升级成功', 'success')
      } catch (e) { this.showToast(e.message, 'warn') }
    },

    // ===== 灌溉 =====
    // 进入/退出放置模式（再次点击同类按钮取消）
    setIrrBuildMode(kind) {
      this.irrBuildMode = this.irrBuildMode === kind ? null : kind
    },
    async buildIrrigation(kind, x, y) {
      try {
        await api('/irrigation/build', 'POST', { kind, x, y })
        await this.load()
        this.showToast(kind === 'reservoir' ? '蓄水池已建成，铺设水渠连接地块吧' : '水渠已铺设', 'success')
        // 蓄水池一次一座；水渠保持模式可连续铺设
        if (kind === 'reservoir') this.irrBuildMode = null
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async toggleIrrigation(id) {
      try {
        const r = await api('/irrigation/toggle', 'POST', { id })
        await this.load()
        this.showToast(r.active ? '已启用，恢复供水' : '已停用，供水网络断流', 'info')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async demolishIrrigation(id) {
      try {
        const r = await api('/irrigation/demolish', 'POST', { id })
        await this.load()
        this.showToast(`已拆除，返还 🪙${r.refund}`, 'info')
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async setIrrPriority(plotId, priority) {
      try {
        await api('/irrigation/priority', 'POST', { plotId, priority })
        await this.load()
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async setIrrTarget(plotId, target) {
      try {
        await api('/irrigation/target', 'POST', { plotId, target })
        await this.load()
      } catch (e) { this.showToast(e.message, 'warn') }
    },

    // ===== 杂交育种 =====
    async startBreeding(parentA, parentB) {
      try {
        await api('/breeding/start', 'POST', { parentA, parentB })
        await this.load()
        this.showToast('🧬 杂交试验已开始，随游戏天推进，注意浇水施肥与防灾', 'success')
      } catch (e) { this.showToast(e.message, 'warn'); throw e }
    },
    async careBreeding(id, action) {
      try {
        await api('/breeding/care', 'POST', { id, action })
        await this.load()
      } catch (e) { this.showToast(e.message, 'warn') }
    },
    async cancelBreeding(id) {
      try {
        await api('/breeding/cancel', 'POST', { id })
        await this.load()
        this.showToast('试验已取消（亲本已消耗不退）', 'info')
      } catch (e) { this.showToast(e.message, 'warn') }
    },

    selectPlot(id) {
      this.selectedPlot = this.plots.find((p) => p.id === id) || null
    },
    setSeedMode(s) { this.seedMode = s }
  }
})