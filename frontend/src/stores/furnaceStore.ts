/**
 * 窑炉与料液状态管理（Pinia）
 * 维护窑炉列表、料液批次及剩余量；取料按剩余量扣减，低于阈值高亮提示补料。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Furnace, FurnaceDraft, FurnaceState, FurnaceType } from '../types/furnace'
import type { GlassBatch, GlassBatchDraft } from '../types/batch'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  consumeBatch,
  countAll,
  db,
  initDatabase,
  putBatch,
  putFurnace,
  reconcilePieces,
  removeBatch,
  removeFurnace,
} from '../utils/db'
import { LOW_REMAIN_KG, isLowRemain, reconcileByFurnace, type FurnaceReconcileRow } from '../utils/thermal'
import { nowIso, uuid } from '../utils/id'

/** 窑炉筛选条件 */
export interface FurnaceFilters {
  keyword: string
  type: FurnaceType | 'all'
  state: FurnaceState | 'all'
}

/** 单台窑炉的派生统计 */
export interface FurnaceStat {
  furnaceId: string
  batchCount: number
  totalRemainKg: number
  lowCount: number
  /** 关联作品数（通过料液批次反查） */
  pieceCount: number
}

const EMPTY_FILTERS: FurnaceFilters = { keyword: '', type: 'all', state: 'all' }

const EMPTY_STAT: Omit<FurnaceStat, 'furnaceId'> = {
  batchCount: 0,
  totalRemainKg: 0,
  lowCount: 0,
  pieceCount: 0,
}

let subscribed = false

export const useFurnaceStore = defineStore('furnace', () => {
  const furnaces = ref<Furnace[]>([])
  const batches = ref<GlassBatch[]>([])
  const pieces = ref<{ id: string; batchId: string }[]>([])
  /** 技师侧工序镜像（只读）：用于设备侧按窑炉对账与退回提示 */
  const steps = ref<Step[]>([])
  /** 作品挂起镜像（只读） */
  const suspendedPieces = ref<Piece[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<FurnaceFilters>({ ...EMPTY_FILTERS })

  const meltingFurnaces = computed<Furnace[]>(() =>
    furnaces.value.filter((row) => row.type === '熔化炉' || row.type === '坩埚炉')
  )
  const annealingFurnaces = computed<Furnace[]>(() => furnaces.value.filter((row) => row.type === '退火窑'))
  const lowRemainBatches = computed<GlassBatch[]>(() => batches.value.filter((row) => isLowRemain(row.remainKg)))

  /** 两边按窑炉对账的派生结果（窑号对不上 / 超上限 / 挂起件数） */
  const reconcile = computed(() => reconcileByFurnace(furnaces.value, steps.value))
  const reconcileRowsById = computed<Record<string, FurnaceReconcileRow>>(() =>
    Object.fromEntries(reconcile.value.rows.map((row) => [row.furnaceId, row]))
  )
  /** 窑炉已被删除、工序仍挂着它的孤儿记录数 */
  const orphanCount = computed<number>(() => reconcile.value.orphans.length)
  const suspendedCount = computed<number>(() => suspendedPieces.value.filter((row) => row.suspended).length)

  /** 挂在某台窑上、被退回（超当时上限）的未完成工序 */
  function overLimitStepsOfFurnace(furnaceId: string): Step[] {
    return steps.value.filter(
      (row) => row.furnaceId === furnaceId && !row.legacy && row.checkState === '超上限' && row.state !== '已完成',
    )
  }

  /** 某台窑上还没推进（未完成）的工序：改最高温度后这些会重算 */
  function pendingStepsOfFurnace(furnaceId: string): Step[] {
    return steps.value.filter(
      (row) => row.furnaceId === furnaceId && !row.legacy && row.state !== '已完成',
    )
  }

  function reconcileRowOf(furnaceId: string): FurnaceReconcileRow | undefined {
    return reconcileRowsById.value[furnaceId]
  }

  const stats = computed<Record<string, FurnaceStat>>(() => {
    const result: Record<string, FurnaceStat> = {}
    furnaces.value.forEach((furnace) => {
      const list = batches.value.filter((row) => row.furnaceId === furnace.id)
      const batchIds = new Set(list.map((row) => row.id))
      result[furnace.id] = {
        furnaceId: furnace.id,
        batchCount: list.length,
        totalRemainKg: Math.round(list.reduce((acc, row) => acc + row.remainKg, 0) * 10) / 10,
        lowCount: list.filter((row) => isLowRemain(row.remainKg)).length,
        pieceCount: pieces.value.filter((row) => batchIds.has(row.batchId)).length,
      }
    })
    return result
  })

  const visibleFurnaces = computed<Furnace[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return furnaces.value.filter((furnace) => {
      if (filters.type !== 'all' && furnace.type !== filters.type) return false
      if (filters.state !== 'all' && furnace.state !== filters.state) return false
      if (keyword === '') return true
      return (
        furnace.code.toLowerCase().includes(keyword) ||
        furnace.type.toLowerCase().includes(keyword) ||
        furnace.fuelType.toLowerCase().includes(keyword)
      )
    })
  })

  function statOf(furnaceId: string): FurnaceStat {
    return stats.value[furnaceId] ?? { furnaceId, ...EMPTY_STAT }
  }

  function batchesOf(furnaceId: string): GlassBatch[] {
    return batches.value.filter((row) => row.furnaceId === furnaceId)
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [furnaceRows, batchRows, pieceRows, stepRows] = await Promise.all([
            db.furnaces.toArray(),
            db.batches.toArray(),
            db.pieces.toArray(),
            db.steps.toArray(),
          ])
          return { furnaceRows, batchRows, pieceRows, stepRows }
        }).subscribe({
          next: ({ furnaceRows, batchRows, pieceRows, stepRows }) => {
            furnaces.value = [...furnaceRows].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
            batches.value = [...batchRows].sort((a, b) => b.meltDate.localeCompare(a.meltDate))
            pieces.value = pieceRows.map((row) => ({ id: row.id, batchId: row.batchId }))
            suspendedPieces.value = pieceRows.filter((row) => row.suspended)
            steps.value = [...stepRows].sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取窑炉数据失败'
            loading.value = false
          },
        })
      }
      await refreshCounts()
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<FurnaceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createFurnace(draft: FurnaceDraft): Promise<Furnace> {
    const stamp = nowIso()
    const row: Furnace = {
      id: uuid('furnace'),
      code: draft.code.trim() || '未编号窑炉',
      type: draft.type,
      maxTempC: draft.maxTempC,
      fuelType: draft.fuelType,
      state: draft.state,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putFurnace(row)
    revision.value += 1
    lastMessage.value =
      row.type === '退火窑' ? `已新建退火窑「${row.code}」，窑位已进入窑位池` : `已新建窑炉「${row.code}」，可挂料液批次`
    return row
  }

  async function updateFurnace(furnaceId: string, draft: FurnaceDraft): Promise<void> {
    const existing = furnaces.value.find((row) => row.id === furnaceId)
    if (existing === undefined) return
    const maxChanged = existing.maxTempC !== draft.maxTempC
    const pendingCount = pendingStepsOfFurnace(furnaceId).length
    await putFurnace({
      ...existing,
      code: draft.code.trim() || existing.code,
      type: draft.type,
      maxTempC: draft.maxTempC,
      fuelType: draft.fuelType,
      state: draft.state,
    })
    revision.value += 1
    if (maxChanged) {
      lastMessage.value =
        pendingCount > 0
          ? `「${draft.code}」最高温度已改为 ${draft.maxTempC} ℃，挂在该窑、还没推进的 ${pendingCount} 道工序已按新上限重算（烧成的老工序不动）。`
          : `「${draft.code}」最高温度已改为 ${draft.maxTempC} ℃，没有需要重算的未推进工序。`
    }
  }

  async function deleteFurnace(furnaceId: string): Promise<void> {
    await removeFurnace(furnaceId)
    await refreshCounts()
    revision.value += 1
    lastMessage.value = '窑炉及其料液批次已删除'
  }

  async function createBatch(draft: GlassBatchDraft): Promise<GlassBatch> {
    const stamp = nowIso()
    const row: GlassBatch = {
      id: uuid('batch'),
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || '未命名色号',
      recipe: draft.recipe.trim(),
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      remainKg: draft.remainKg,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putBatch(row)
    revision.value += 1
    return row
  }

  async function updateBatch(batchId: string, draft: GlassBatchDraft): Promise<void> {
    const existing = batches.value.find((row) => row.id === batchId)
    if (existing === undefined) return
    await putBatch({
      ...existing,
      furnaceId: draft.furnaceId,
      colorCode: draft.colorCode.trim() || existing.colorCode,
      recipe: draft.recipe.trim(),
      meltDate: draft.meltDate,
      tempC: draft.tempC,
      remainKg: draft.remainKg,
    })
    revision.value += 1
  }

  async function deleteBatch(batchId: string): Promise<void> {
    await removeBatch(batchId)
    revision.value += 1
  }

  /** 取料：按剩余量扣减，返回实际扣减量 */
  async function consume(batchId: string, kg: number): Promise<number> {
    const actual = await consumeBatch(batchId, kg)
    revision.value += 1
    const batch = batches.value.find((row) => row.id === batchId)
    if (batch !== undefined) {
      const remain = Math.round((batch.remainKg - actual) * 10) / 10
      lastMessage.value = isLowRemain(remain)
        ? `已取料 ${actual} kg，${batch.colorCode} 剩余 ${remain} kg，低于 ${LOW_REMAIN_KG} kg，请及时补料`
        : `已取料 ${actual} kg，${batch.colorCode} 剩余 ${remain} kg`
    }
    return actual
  }

  /** 补料：直接增加剩余量 */
  async function refill(batchId: string, kg: number): Promise<void> {
    const batch = batches.value.find((row) => row.id === batchId)
    if (batch === undefined) return
    await putBatch({ ...batch, remainKg: Math.round((batch.remainKg + kg) * 10) / 10 })
    revision.value += 1
    lastMessage.value = `已为 ${batch.colorCode} 补料 ${kg} kg`
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  /** 设备侧发起按窑炉对账：窑号对不上的作品挂起，对上后解除 */
  async function runReconcile(): Promise<number> {
    const count = await reconcilePieces()
    revision.value += 1
    lastMessage.value =
      count > 0 ? `对账完成：${count} 件作品窑号对不上，已挂起。` : '对账完成：工序窑号与设备台账全部一致。'
    return count
  }

  return {
    furnaces,
    batches,
    steps,
    suspendedPieces,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    meltingFurnaces,
    annealingFurnaces,
    lowRemainBatches,
    stats,
    visibleFurnaces,
    reconcile,
    reconcileRowsById,
    orphanCount,
    suspendedCount,
    statOf,
    batchesOf,
    overLimitStepsOfFurnace,
    pendingStepsOfFurnace,
    reconcileRowOf,
    runReconcile,
    loadAll,
    setFilters,
    resetFilters,
    createFurnace,
    updateFurnace,
    deleteFurnace,
    createBatch,
    updateBatch,
    deleteBatch,
    consume,
    refill,
    refreshCounts,
  }
})
