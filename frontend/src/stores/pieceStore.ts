/**
 * 作品与工序状态管理（Pinia）
 * 维护作品列表、当前作品与当前作品的工序；工序状态由 db.syncPieceState 联动作品状态。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Craft, Piece, PieceDraft, PieceState } from '../types/piece'
import type { Step, StepCheckState, StepDraft } from '../types/step'
import type { StepOutbox } from '../types/stepOutbox'
import type { Furnace } from '../types/furnace'
import {
  DB_SCHEMA_VERSION,
  ROW_REVISION,
  clearStepOutbox,
  countAll,
  db,
  flushStepOutbox,
  initDatabase,
  listStepOutbox,
  putPiece,
  putStep,
  removePiece,
  removeStep,
  reorderSteps,
  reconcilePieces,
  syncPieceState,
} from '../utils/db'
import { buildStepProgress, type StepProgress } from '../hooks/useStepProgress'
import { checkStepCap } from '../utils/thermal'
import { nowIso, uuid } from '../utils/id'

/** 作品筛选条件 */
export interface PieceFilters {
  keyword: string
  craft: Craft | 'all'
  state: PieceState | 'all'
}

const EMPTY_FILTERS: PieceFilters = { keyword: '', craft: 'all', state: 'all' }

const CURRENT_PIECE_KEY = 'gbglassblow:currentPieceId'

function readCurrentPieceId(): string | null {
  try {
    const raw = window.localStorage.getItem(CURRENT_PIECE_KEY)
    return raw === null || raw === '' ? null : raw
  } catch {
    return null
  }
}

function writeCurrentPieceId(id: string | null): void {
  try {
    window.localStorage.setItem(CURRENT_PIECE_KEY, id ?? '')
  } catch {
    /* 隐私模式下写入失败时静默降级 */
  }
}

let subscribed = false

export const usePieceStore = defineStore('piece', () => {
  const pieces = ref<Piece[]>([])
  const steps = ref<Step[]>([])
  /** 设备台账侧窑炉（只读镜像，供工序挂窑与上限卡温用） */
  const furnaces = ref<Furnace[]>([])
  /** 技师侧落账失败的待重试队列（设备侧不读不写这张表） */
  const outbox = ref<StepOutbox[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const counts = ref<Record<string, number>>({})
  const lastMessage = ref('')
  const revision = ref(0)
  const currentPieceId = ref<string | null>(readCurrentPieceId())
  const filters = reactive<PieceFilters>({ ...EMPTY_FILTERS })

  const currentPiece = computed<Piece | null>(
    () => pieces.value.find((row) => row.id === currentPieceId.value) ?? null
  )

  /** 被对账挂起的作品 */
  const suspendedPieces = computed<Piece[]>(() => pieces.value.filter((row) => row.suspended))

  function isSuspended(pieceId: string): boolean {
    return pieces.value.find((row) => row.id === pieceId)?.suspended ?? false
  }

  function suspendReasonOf(pieceId: string): string {
    return pieces.value.find((row) => row.id === pieceId)?.suspendReason ?? ''
  }

  /** 某台窑炉上被退回（超当时上限）的未完成工序，供设备台账侧提示 */
  function overLimitStepsOfFurnace(furnaceId: string): Step[] {
    return steps.value.filter((row) => row.furnaceId === furnaceId && row.checkState === '超上限')
  }

  const visiblePieces = computed<Piece[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return pieces.value.filter((piece) => {
      if (filters.craft !== 'all' && piece.craft !== filters.craft) return false
      if (filters.state !== 'all' && piece.state !== filters.state) return false
      if (keyword === '') return true
      return (
        piece.name.toLowerCase().includes(keyword) ||
        piece.artist.toLowerCase().includes(keyword) ||
        piece.craft.toLowerCase().includes(keyword)
      )
    })
  })

  function stepsOf(pieceId: string): Step[] {
    return steps.value.filter((row) => row.pieceId === pieceId).sort((a, b) => a.seq - b.seq)
  }

  function progressOf(pieceId: string): StepProgress {
    return buildStepProgress(pieceId, steps.value)
  }

  const inProgressCount = computed<number>(
    () => pieces.value.filter((row) => row.state === '设计中' || row.state === '制作中').length
  )

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [pieceRows, stepRows, outboxRows, furnaceRows] = await Promise.all([
            db.pieces.toArray(),
            db.steps.toArray(),
            db.stepOutbox.toArray(),
            db.furnaces.toArray(),
          ])
          return { pieceRows, stepRows, outboxRows, furnaceRows }
        }).subscribe({
          next: ({ pieceRows, stepRows, outboxRows, furnaceRows }) => {
            const sorted = [...pieceRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            pieces.value = sorted
            steps.value = [...stepRows].sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
            outbox.value = [...outboxRows].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
            furnaces.value = [...furnaceRows].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
            loading.value = false
            ready.value = true
            error.value = ''
            const stillExists =
              currentPieceId.value !== null && sorted.some((row) => row.id === currentPieceId.value)
            if (!stillExists) {
              selectPiece(sorted.length > 0 ? sorted[0].id : null)
            }
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取作品数据失败'
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

  function selectPiece(pieceId: string | null): void {
    currentPieceId.value = pieceId
    writeCurrentPieceId(pieceId)
  }

  function setFilters(patch: Partial<PieceFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createPiece(draft: PieceDraft): Promise<Piece> {
    const stamp = nowIso()
    const row: Piece = {
      id: uuid('piece'),
      name: draft.name.trim() || '未命名作品',
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      state: draft.state,
      suspended: false,
      suspendReason: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putPiece(row)
    selectPiece(row.id)
    revision.value += 1
    lastMessage.value = `已登记作品「${row.name}」，可继续录入吹制工序`
    return row
  }

  async function updatePiece(pieceId: string, draft: PieceDraft): Promise<void> {
    const existing = pieces.value.find((row) => row.id === pieceId)
    if (existing === undefined) return
    await putPiece({
      ...existing,
      name: draft.name.trim() || existing.name,
      batchId: draft.batchId,
      designHeightMm: draft.designHeightMm,
      wallThicknessMm: draft.wallThicknessMm,
      craft: draft.craft,
      artist: draft.artist.trim(),
      state: draft.state,
    })
    revision.value += 1
  }

  async function deletePiece(pieceId: string): Promise<void> {
    await removePiece(pieceId)
    if (currentPieceId.value === pieceId) selectPiece(null)
    await refreshCounts()
    revision.value += 1
    lastMessage.value = '作品及其工序、退火与检验记录已删除'
  }

  /* ------------------------------ 工序 ------------------------------ */

  /** 解析某道工序当时挂的窑炉（设备台账镜像） */
  function furnaceOfStep(furnaceId: string): Furnace | undefined {
    return furnaces.value.find((row) => row.id === furnaceId)
  }

  /**
   * 落一道工序账的统一入口：
   * - 挂起 / 只读老记录拦截；
   * - 温度按「当时窑炉上限」硬卡，超出只退回这一道，不动其它已烧成工序；
   * - 落账失败转技师侧 stepOutbox 本侧重试，设备侧不受影响。
   */
  async function saveStep(draft: StepDraft, editingId: string | null): Promise<{ ok: boolean; message: string; queued: boolean }> {
    const piece = pieces.value.find((row) => row.id === draft.pieceId)
    if (!piece) return { ok: false, message: '作品不存在，无法记录工序。', queued: false }
    if (piece.suspended) {
      return { ok: false, message: `该件已按窑炉对账挂起：${piece.suspendReason}`, queued: false }
    }
    if (editingId !== null) {
      const target = steps.value.find((row) => row.id === editingId)
      if (target?.legacy) return { ok: false, message: '这是升级前没记窑号、又回填不了归属的老工序，按规定只读保留。', queued: false }
    }
    const furnace = furnaces.value.find((row) => row.id === draft.furnaceId)
    if (!furnace) return { ok: false, message: '请先为这道工序选择当时所用的窑炉。', queued: false }

    // 温度按当时窑炉上限卡住：超出的只退回这一道
    const cap = checkStepCap(draft.tempC, furnace.maxTempC, furnace.code)
    if (!cap.ok) return { ok: false, message: cap.message, queued: false }

    const stamp = nowIso()
    const checkState: StepCheckState = '正常'
    if (editingId === null) {
      const row: Step = {
        id: uuid('step'),
        pieceId: draft.pieceId,
        seq: draft.seq,
        name: draft.name,
        tempC: draft.tempC,
        durationMin: draft.durationMin,
        operator: draft.operator.trim(),
        remark: draft.remark.trim(),
        state: draft.state,
        furnaceId: furnace.id,
        furnaceCode: furnace.code,
        capTempC: furnace.maxTempC,
        checkState,
        checkedAt: stamp,
        legacy: false,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }
      const landed = await putStep(row)
      revision.value += 1
      return landed
        ? { ok: true, message: `已新增第 ${draft.seq} 道「${draft.name}」`, queued: false }
        : { ok: true, message: `第 ${draft.seq} 道已收下，但本地台账暂未写成，已进技师侧重试队列。`, queued: true }
    }

    const existing = steps.value.find((row) => row.id === editingId)
    if (existing === undefined) return { ok: false, message: '待编辑的工序不存在。', queued: false }
    const row: Step = {
      ...existing,
      seq: draft.seq,
      name: draft.name,
      tempC: draft.tempC,
      durationMin: draft.durationMin,
      operator: draft.operator.trim(),
      remark: draft.remark.trim(),
      state: draft.state,
      furnaceId: furnace.id,
      furnaceCode: furnace.code,
      capTempC: furnace.maxTempC,
      checkState,
      checkedAt: stamp,
      legacy: false,
    }
    const landed = await putStep(row)
    revision.value += 1
    return landed
      ? { ok: true, message: '工序已更新', queued: false }
      : { ok: true, message: '修改已收下，但本地台账暂未写成，已进技师侧重试队列。', queued: true }
  }

  async function createStep(draft: StepDraft): Promise<{ ok: boolean; queued: boolean }> {
    const result = await saveStep(draft, null)
    lastMessage.value = result.message
    return { ok: result.ok, queued: result.queued }
  }

  async function updateStep(stepId: string, draft: StepDraft): Promise<boolean> {
    const result = await saveStep(draft, stepId)
    lastMessage.value = result.message
    return result.ok
  }

  async function deleteStep(stepId: string): Promise<void> {
    const target = steps.value.find((row) => row.id === stepId)
    if (!target) return
    if (target.legacy) {
      lastMessage.value = '回填不了窑号的老工序只读保留，不能删除。'
      return
    }
    const landed = await removeStep(stepId)
    revision.value += 1
    lastMessage.value = landed
      ? '工序已删除，作品状态已重新推导'
      : '删除请求已进技师侧重试队列，本地台账稍后重试。'
  }

  /** 推进工序状态：未开始 → 进行中 → 已完成；挂起件 / 超上限退回道 / 只读老记录不可推进 */
  async function advanceStep(stepId: string): Promise<void> {
    const existing = steps.value.find((row) => row.id === stepId)
    if (existing === undefined) return
    if (existing.legacy) {
      lastMessage.value = '回填不了窑号的老工序只读保留，不能推进。'
      return
    }
    if (isSuspended(existing.pieceId)) {
      lastMessage.value = `作品已挂起，工序暂停推进：${suspendReasonOf(existing.pieceId)}`
      return
    }
    if (existing.checkState === '超上限') {
      lastMessage.value = `第 ${existing.seq} 道「${existing.name}」温度超过当时窑炉上限被退回，请先改温度或换窑，再推进。`
      return
    }
    const flow: Step['state'][] = ['未开始', '进行中', '已完成']
    const index = flow.indexOf(existing.state)
    if (index < 0 || index >= flow.length - 1) {
      lastMessage.value = '该工序已处于「已完成」状态'
      return
    }
    const next = flow[index + 1]
    const landed = await putStep({ ...existing, state: next })
    revision.value += 1
    const piece = pieces.value.find((row) => row.id === existing.pieceId)
    lastMessage.value = landed
      ? `第 ${existing.seq} 道「${existing.name}」已推进为「${next}」${piece === undefined ? '' : `（作品：${piece.name}）`}`
      : '推进已收下，但本地台账暂未写成，已进技师侧重试队列。'
  }

  /** 拖拽排序：把 fromId 移动到 toId 之前 */
  async function moveStepBefore(pieceId: string, fromId: string, toId: string): Promise<void> {
    if (fromId === toId) return
    if (isSuspended(pieceId)) {
      lastMessage.value = '作品已挂起，工序顺序锁定。'
      return
    }
    const list = stepsOf(pieceId).filter((row) => !row.legacy)
    const fromIndex = list.findIndex((row) => row.id === fromId)
    const toIndex = list.findIndex((row) => row.id === toId)
    if (fromIndex < 0 || toIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    await reorderSteps(list.map((row) => row.id))
    revision.value += 1
    lastMessage.value = `已调整工序顺序：「${moved.name}」移动到第 ${toIndex + 1} 道`
  }

  /** 按序号升序重排（拖拽置顶/置底等场景） */
  async function moveStepToIndex(pieceId: string, stepId: string, targetIndex: number): Promise<void> {
    if (isSuspended(pieceId)) {
      lastMessage.value = '作品已挂起，工序顺序锁定。'
      return
    }
    const list = stepsOf(pieceId).filter((row) => !row.legacy)
    const fromIndex = list.findIndex((row) => row.id === stepId)
    if (fromIndex < 0) return
    const [moved] = list.splice(fromIndex, 1)
    const index = Math.max(0, Math.min(list.length, targetIndex))
    list.splice(index, 0, moved)
    await reorderSteps(list.map((row) => row.id))
    revision.value += 1
    lastMessage.value = `已把「${moved.name}」调整到第 ${index + 1} 道`
  }

  /** 依工序与退火记录重新推导作品状态 */
  async function resyncPieceState(pieceId: string): Promise<void> {
    const next = await syncPieceState(pieceId)
    revision.value += 1
    if (next !== null) lastMessage.value = `作品状态已重新推导为「${next}」`
  }

  /** 两边按窑炉重新对账：窑号对不上的作品挂起，重新对上即解除 */
  async function runReconcile(): Promise<number> {
    const suspendedCount = await reconcilePieces()
    revision.value += 1
    lastMessage.value =
      suspendedCount > 0 ? `对账完成：${suspendedCount} 件作品窑号对不上，已挂起。` : '对账完成：全部作品窑号与设备台账一致。'
    return suspendedCount
  }

  /** 技师侧按本侧重试落账队列（设备侧不参与） */
  async function retryOutbox(): Promise<number> {
    const remaining = await flushStepOutbox()
    revision.value += 1
    lastMessage.value =
      remaining === 0 ? '技师侧待重试落账已全部写入台账。' : `仍有 ${remaining} 条落账未写成，已保留待下次重试。`
    return remaining
  }

  async function loadOutbox(): Promise<void> {
    outbox.value = await listStepOutbox()
  }

  async function discardOutbox(): Promise<void> {
    await clearStepOutbox()
    outbox.value = []
    revision.value += 1
    lastMessage.value = '已清空技师侧待重试队列。'
  }

  async function refreshCounts(): Promise<void> {
    const result = await countAll()
    counts.value = { ...result, schemaVersion: DB_SCHEMA_VERSION }
  }

  return {
    pieces,
    steps,
    furnaces,
    outbox,
    loading,
    ready,
    error,
    counts,
    filters,
    lastMessage,
    revision,
    currentPieceId,
    currentPiece,
    visiblePieces,
    inProgressCount,
    suspendedPieces,
    stepsOf,
    progressOf,
    isSuspended,
    suspendReasonOf,
    overLimitStepsOfFurnace,
    furnaceOfStep,
    loadAll,
    selectPiece,
    setFilters,
    resetFilters,
    createPiece,
    updatePiece,
    deletePiece,
    saveStep,
    createStep,
    updateStep,
    deleteStep,
    advanceStep,
    moveStepBefore,
    moveStepToIndex,
    resyncPieceState,
    runReconcile,
    retryOutbox,
    loadOutbox,
    discardOutbox,
    refreshCounts,
  }
})
