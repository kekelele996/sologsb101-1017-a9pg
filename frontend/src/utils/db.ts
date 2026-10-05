/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbglassblow
 * - 含数据结构版本号与升级迁移逻辑：
 *   v1 → v2 为 Piece 增加 craft 索引并回填默认值；
 *   v2 → v3 为工序挂窑炉（窑号/上限快照）、作品增加对账挂起、新增技师侧重试队列表 stepOutbox。
 * - 两边各记各的：设备侧（furnaces/batches）与技师侧（steps/stepOutbox）分表，
 *   技师落账失败只进本侧重试队列，设备侧不受影响。
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece, PieceState } from '../types/piece'
import type { Step } from '../types/step'
import type { StepOutbox } from '../types/stepOutbox'
import type { Anneal } from '../types/anneal'
import type { Inspect } from '../types/inspect'
import { nowIso } from './id'
import { seedDatabase } from './seed'
import { recalcStepsForFurnace, reconcileByFurnace } from './thermal'

/** 数据库名 */
export const DB_NAME = 'gbglassblow'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class GlassBlowDatabase extends Dexie {
  furnaces!: Table<Furnace, string>
  batches!: Table<GlassBatch, string>
  pieces!: Table<Piece, string>
  steps!: Table<Step, string>
  stepOutbox!: Table<StepOutbox, string>
  anneals!: Table<Anneal, string>
  inspects!: Table<Inspect, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      furnaces: 'id, code, type, state, fuelType, createdAt',
      batches: 'id, furnaceId, colorCode, meltDate',
      pieces: 'id, batchId, state, artist',
      steps: 'id, pieceId, [pieceId+seq], seq',
      anneals: 'id, pieceId, kilnSlot, state, inAt',
      inspects: 'id, pieceId, date, result',
    })

    // ---------- v2：Piece 增加 craft 索引并回填默认值，补齐其余索引与字段 ----------
    this.version(2)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        // craft 为 v2 新增索引
        pieces: 'id, batchId, state, artist, craft, name',
        steps: 'id, pieceId, [pieceId+seq], seq, state, name',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = 2
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：Piece 补齐 craft 字段（历史作品默认按吹制归类）
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
        })
        // 迁移 3：历史工序默认视为已执行完成，避免升级后被误判为待办
        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''
        })
        // 迁移 4：退火记录补齐出炉时间与曲线段
        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        // 迁移 5：检验记录补齐缺陷说明
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })
      })

    // ---------- v3：工序挂窑炉、作品对账挂起、技师侧重试队列 ----------
    this.version(DB_SCHEMA_VERSION)
      .stores({
        furnaces: 'id, code, type, state, fuelType, createdAt, updatedAt',
        batches: 'id, furnaceId, colorCode, meltDate, remainKg',
        // suspended 为 v3 新增索引
        pieces: 'id, batchId, state, artist, craft, name, suspended',
        // furnaceId / checkState 为 v3 新增索引
        steps: 'id, pieceId, [pieceId+seq], seq, state, name, furnaceId, checkState',
        // 技师侧落账失败的本侧重试队列（与设备表完全分开）
        stepOutbox: 'id, stepId, op, attempts, updatedAt',
        anneals: 'id, pieceId, kilnSlot, state, inAt, curveSeg',
        inspects: 'id, pieceId, date, result, inspector',
      })
      .upgrade(async (tx) => {
        // —— 先跑一遍 v2 时代的兜底回填（从更早 v1 直接升到 v3 的库也要补齐） ——
        const allTables = [
          tx.table('furnaces'),
          tx.table('batches'),
          tx.table('pieces'),
          tx.table('steps'),
          tx.table('anneals'),
          tx.table('inspects'),
        ]
        for (const table of allTables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.revision !== 'number') row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        await tx.table('pieces').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.craft !== 'string' || row.craft === '') row.craft = '吹制'
          if (typeof row.state !== 'string' || row.state === '') row.state = '设计中'
          // 对账挂起字段
          if (typeof row.suspended !== 'boolean') row.suspended = false
          if (typeof row.suspendReason !== 'string') row.suspendReason = ''
        })

        // —— 旧工序没记窑号：升级时按归属（作品 → 料液批次 → 窑炉）回填 ——
        const [furnaceRows, batchRows, pieceRows] = await Promise.all([
          tx.table('furnaces').toArray() as Promise<Furnace[]>,
          tx.table('batches').toArray() as Promise<GlassBatch[]>,
          tx.table('pieces').toArray() as Promise<Piece[]>,
        ])
        const furnaceById = new Map(furnaceRows.map((furnace) => [furnace.id, furnace]))
        const batchById = new Map(batchRows.map((batch) => [batch.id, batch]))
        const pieceById = new Map(pieceRows.map((piece) => [piece.id, piece]))

        await tx.table('anneals').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.outAt !== 'string') row.outAt = ''
          if (typeof row.curveSeg !== 'string' || row.curveSeg === '') row.curveSeg = '缓冷'
        })
        await tx.table('inspects').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.defectNote !== 'string') row.defectNote = ''
        })

        await tx.table('steps').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.state !== 'string' || row.state === '') row.state = '已完成'
          if (typeof row.remark !== 'string') row.remark = ''

          // 已经是新结构（有窑号快照）的工序，只需补齐核对字段
          if (typeof row.furnaceCode === 'string' && row.furnaceCode !== '') {
            if (typeof row.furnaceId !== 'string') row.furnaceId = ''
            const cap = typeof row.capTempC === 'number' ? row.capTempC : Number.POSITIVE_INFINITY
            if (typeof row.capTempC !== 'number') row.capTempC = cap
            if (row.checkState !== '正常' && row.checkState !== '超上限') {
              row.checkState = typeof row.tempC === 'number' && row.tempC > cap ? '超上限' : '正常'
            }
            if (typeof row.checkedAt !== 'string') row.checkedAt = row.updatedAt ?? nowIso()
            row.legacy = false
            row.revision = ROW_REVISION
            return
          }

          // 旧数据：沿归属链找窑炉回填
          const piece = typeof row.pieceId === 'string' ? pieceById.get(row.pieceId) : undefined
          const batch = piece ? batchById.get(piece.batchId) : undefined
          const furnace = batch ? furnaceById.get(batch.furnaceId) : undefined
          if (furnace) {
            row.furnaceId = furnace.id
            row.furnaceCode = furnace.code
            row.capTempC = furnace.maxTempC
            // 老工序按当时上限只标结果，不退回、不改动温度
            row.checkState =
              typeof row.tempC === 'number' && row.tempC > furnace.maxTempC ? '超上限' : '正常'
            row.checkedAt = row.updatedAt ?? nowIso()
            row.legacy = false
          } else {
            // 归属链断了填不了：老记录只读保留
            row.furnaceId = ''
            row.furnaceCode = ''
            row.capTempC = 0
            row.checkState = '正常'
            row.checkedAt = ''
            row.legacy = true
          }
          row.revision = ROW_REVISION
        })
      })
  }
}

export const db = new GlassBlowDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 打开后先把技师侧遗留的待重试落账冲掉（设备侧不受影响）
      await flushStepOutbox()
      // 结构升级 / 历史数据后按窑炉核一遍挂起状态（全新库或一致数据时为空操作）
      await reconcilePieces()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.furnaces.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
}

/* -------------------------------- 窑炉 -------------------------------- */

export async function listFurnaces(): Promise<Furnace[]> {
  const rows = await db.furnaces.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function putFurnace(row: Furnace): Promise<void> {
  const prev = await db.furnaces.get(row.id)
  await db.furnaces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  // 最高温度改动后：还没推进（未完成）的工序按新上限重算；烧成的老工序原样保留
  if (prev && prev.maxTempC !== row.maxTempC) {
    await recalcPendingStepsForFurnace(row.id)
  }
  // 窑号 / 上限都可能影响对账结论，落库后重算挂起
  await reconcilePieces()
}

/** 删除窑炉：级联清理其料液批次；工序不删除（留痕），对账时按窑炉缺失挂起 */
export async function removeFurnace(id: string): Promise<void> {
  await db.transaction('rw', db.furnaces, db.batches, async () => {
    await db.batches.where('furnaceId').equals(id).delete()
    await db.furnaces.delete(id)
  })
  await reconcilePieces()
}

/** 按一台窑炉的最新台账，重算挂在它上面、尚未推进的工序上限快照与核对结果 */
async function recalcPendingStepsForFurnace(furnaceId: string): Promise<void> {
  const [furnace, steps] = await Promise.all([
    db.furnaces.get(furnaceId),
    db.steps.where('furnaceId').equals(furnaceId).toArray(),
  ])
  if (!furnace) return
  const stamp = nowIso()
  const changes = recalcStepsForFurnace(steps, furnace)
  if (changes.length === 0) return
  await db.transaction('rw', db.steps, async () => {
    for (const change of changes) {
      await db.steps.update(change.stepId, {
        furnaceCode: change.furnaceCode,
        capTempC: change.capTempC,
        checkState: change.checkState,
        checkedAt: stamp,
        updatedAt: stamp,
      })
    }
  })
}

/* ------------------------------ 料液批次 ------------------------------ */

export async function listBatches(): Promise<GlassBatch[]> {
  const rows = await db.batches.toArray()
  return rows.sort((a, b) => b.meltDate.localeCompare(a.meltDate))
}

export async function putBatch(row: GlassBatch): Promise<void> {
  await db.batches.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeBatch(id: string): Promise<void> {
  await db.batches.delete(id)
}

/** 取料：按剩余量扣减（不足时扣到 0 并返回实际扣减量） */
export async function consumeBatch(batchId: string, kg: number): Promise<number> {
  const batch = await db.batches.get(batchId)
  if (!batch) return 0
  const actual = Math.max(0, Math.min(batch.remainKg, kg))
  await db.batches.update(batchId, { remainKg: Math.round((batch.remainKg - actual) * 10) / 10, updatedAt: nowIso() })
  return actual
}

/* -------------------------------- 作品 -------------------------------- */

export async function listPieces(): Promise<Piece[]> {
  const rows = await db.pieces.toArray()
  return rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function putPiece(row: Piece): Promise<void> {
  await db.pieces.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除作品：级联清理工序、退火、检验与该件的待重试落账 */
export async function removePiece(id: string): Promise<void> {
  await db.transaction('rw', db.pieces, db.steps, db.stepOutbox, db.anneals, db.inspects, async () => {
    const stepIds = await db.steps.where('pieceId').equals(id).primaryKeys()
    await db.stepOutbox.where('stepId').anyOf(stepIds).delete()
    await db.steps.where('pieceId').equals(id).delete()
    await db.anneals.where('pieceId').equals(id).delete()
    await db.inspects.where('pieceId').equals(id).delete()
    await db.pieces.delete(id)
  })
}

/**
 * 依工序与退火、检验记录推导并回写作品状态。
 * 规则：有检验记录 → 已检验；有已出炉退火 → 已退火；有工序记录 → 制作中；否则设计中。
 */
export async function syncPieceState(pieceId: string): Promise<PieceState | null> {
  const piece = await db.pieces.get(pieceId)
  if (!piece) return null
  const [steps, anneals, inspects] = await Promise.all([
    db.steps.where('pieceId').equals(pieceId).toArray(),
    db.anneals.where('pieceId').equals(pieceId).toArray(),
    db.inspects.where('pieceId').equals(pieceId).toArray(),
  ])

  let next: PieceState = '设计中'
  if (steps.length > 0) next = '制作中'
  if (anneals.some((row) => row.state === '已出炉')) next = '已退火'
  if (inspects.length > 0) next = '已检验'

  if (next !== piece.state) {
    await db.pieces.update(pieceId, { state: next, updatedAt: nowIso() })
  }
  return next
}

/* -------------------------------- 工序 -------------------------------- */

export async function listSteps(): Promise<Step[]> {
  const rows = await db.steps.toArray()
  return rows.sort((a, b) => a.pieceId.localeCompare(b.pieceId) || a.seq - b.seq)
}

export async function listStepsByPiece(pieceId: string): Promise<Step[]> {
  const rows = await db.steps.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => a.seq - b.seq)
}

/**
 * 技师侧落一道工序账。
 * 先尝试直接写入 steps；若本地写入失败，则进技师侧 stepOutbox 重试队列，
 * 设备侧（窑炉/料液）完全不受影响。成功后联动作品状态并按窑炉对账。
 * 返回 true 表示已直接落账，false 表示已转入待重试队列。
 */
export async function putStep(row: Step): Promise<boolean> {
  try {
    await db.transaction('rw', db.steps, db.pieces, async () => {
      await db.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
      await syncPieceState(row.pieceId)
    })
    // 同一道若曾落队，直接成功后清掉待重试项
    await db.stepOutbox.where('stepId').equals(row.id).delete()
    await reconcilePieces()
    return true
  } catch {
    // 设备侧不受影响：落账失败只尝试进技师侧重试队列（入队本身再失败也静默，等下次启动重试）
    try {
      await enqueueStepOutbox('put', row)
    } catch {
      /* 队列也写不进时忽略，保留原始内存数据，下次操作可再触发 */
    }
    return false
  }
}

export async function removeStep(id: string): Promise<boolean> {
  let step: Step | undefined
  try {
    step = await db.steps.get(id)
  } catch {
    step = undefined
  }
  if (!step) return true
  try {
    await db.transaction('rw', db.steps, db.pieces, async () => {
      await db.steps.delete(id)
      await syncPieceState(step.pieceId)
    })
    await db.stepOutbox.where('stepId').equals(id).delete()
    await reconcilePieces()
    return true
  } catch {
    try {
      await enqueueStepOutbox('delete', null, id)
    } catch {
      /* 队列也写不进时忽略，等下次启动再试 */
    }
    return false
  }
}

/** 按给定 id 顺序重写工序序号（拖拽排序后调用） */
export async function reorderSteps(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.steps, async () => {
    for (let index = 0; index < orderedIds.length; index += 1) {
      await db.steps.update(orderedIds[index], { seq: index + 1, updatedAt: nowIso() })
    }
  })
}

/* --------------------- 技师侧落账失败重试（本侧重试） --------------------- */

async function enqueueStepOutbox(op: 'put', row: Step): Promise<void>
async function enqueueStepOutbox(op: 'delete', row: null, stepId: string): Promise<void>
async function enqueueStepOutbox(op: 'put' | 'delete', row: Step | null, stepId = ''): Promise<void> {
  const targetId = op === 'put' && row ? row.id : stepId
  const stamp = nowIso()
  const existing = await db.stepOutbox.where('stepId').equals(targetId).first()
  const message = '本地工序台账写入失败，已转入技师侧重试队列（设备侧不受影响）。'
  if (existing) {
    await db.stepOutbox.update(existing.id, {
      op,
      payload: row ? JSON.stringify(row) : '',
      attempts: existing.attempts + 1,
      lastError: message,
      updatedAt: stamp,
    })
    return
  }
  await db.stepOutbox.put({
    id: `outbox-${targetId}`,
    stepId: targetId,
    payload: row ? JSON.stringify(row) : '',
    op,
    attempts: 1,
    lastError: message,
    createdAt: stamp,
    updatedAt: stamp,
    revision: ROW_REVISION,
  })
}

export async function listStepOutbox(): Promise<StepOutbox[]> {
  const rows = await db.stepOutbox.toArray()
  return rows.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
}

/**
 * 按本侧重试：把队列里的待落账工序重新写进技师台账。
 * 只动 steps / stepOutbox，不触碰设备表；全部成功后按窑炉对账。
 * 返回仍残留的待重试条数。
 */
export async function flushStepOutbox(): Promise<number> {
  const pending = await db.stepOutbox.toCollection().sortBy('updatedAt')
  for (const item of pending) {
    try {
      if (item.op === 'delete') {
        const step = await db.steps.get(item.stepId)
        await db.steps.delete(item.stepId)
        if (step) await syncPieceState(step.pieceId)
      } else {
        const row = JSON.parse(item.payload) as Step
        await db.transaction('rw', db.steps, db.pieces, async () => {
          await db.steps.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
          await syncPieceState(row.pieceId)
        })
      }
      await db.stepOutbox.delete(item.id)
    } catch {
      // 仍然失败：保留在队列里下次再试，设备侧不做任何回滚
      await db.stepOutbox.update(item.id, { attempts: item.attempts + 1, updatedAt: nowIso() })
    }
  }
  await reconcilePieces()
  return db.stepOutbox.count()
}

export async function clearStepOutbox(): Promise<void> {
  await db.stepOutbox.clear()
}

/* ------------------------------ 按窑炉对账 ------------------------------ */

/**
 * 两边按窑炉对账：工序上写的窑号跟设备台账那份对不上，就把这一件挂起。
 * 回写每件作品的 suspended / suspendReason；重新对上即解除挂起。
 */
export async function reconcilePieces(): Promise<number> {
  const [furnaces, steps, pieces] = await Promise.all([
    db.furnaces.toArray(),
    db.steps.toArray(),
    db.pieces.toArray(),
  ])
  const result = reconcileByFurnace(furnaces, steps)
  const statusById = new Map(result.pieceStatus.map((item) => [item.pieceId, item]))
  const stamp = nowIso()
  await db.transaction('rw', db.pieces, async () => {
    for (const piece of pieces) {
      const status = statusById.get(piece.id)
      const suspended = status?.suspended ?? false
      const reason = status?.reason ?? ''
      if (piece.suspended !== suspended || piece.suspendReason !== reason) {
        await db.pieces.update(piece.id, { suspended, suspendReason: reason, updatedAt: stamp })
      }
    }
  })
  return result.suspendedCount
}

/* -------------------------------- 退火 -------------------------------- */

export async function listAnneals(): Promise<Anneal[]> {
  const rows = await db.anneals.toArray()
  return rows.sort((a, b) => a.inAt.localeCompare(b.inAt))
}

export async function listAnnealsByPiece(pieceId: string): Promise<Anneal[]> {
  return db.anneals.where('pieceId').equals(pieceId).toArray()
}

export async function putAnneal(row: Anneal): Promise<void> {
  await db.anneals.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeAnneal(id: string): Promise<void> {
  const row = await db.anneals.get(id)
  if (!row) return
  await db.anneals.delete(id)
  await syncPieceState(row.pieceId)
}

/** 推进退火状态；「已出炉」时写回出炉时间并同步作品状态 */
export async function advanceAnnealState(annealId: string, next: Anneal['state'], outAt: string): Promise<void> {
  const row = await db.anneals.get(annealId)
  if (!row) return
  await db.anneals.update(annealId, { state: next, outAt: next === '已出炉' ? outAt : row.outAt, updatedAt: nowIso() })
  await syncPieceState(row.pieceId)
}

/* ------------------------------ 出炉检验 ------------------------------ */

export async function listInspects(): Promise<Inspect[]> {
  const rows = await db.inspects.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listInspectsByPiece(pieceId: string): Promise<Inspect[]> {
  const rows = await db.inspects.where('pieceId').equals(pieceId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function putInspect(row: Inspect): Promise<void> {
  await db.inspects.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
  await syncPieceState(row.pieceId)
}

export async function removeInspect(id: string): Promise<void> {
  const row = await db.inspects.get(id)
  if (!row) return
  await db.inspects.delete(id)
  await syncPieceState(row.pieceId)
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  furnaces: Furnace[]
  batches: GlassBatch[]
  pieces: Piece[]
  steps: Step[]
  stepOutbox: StepOutbox[]
  anneals: Anneal[]
  inspects: Inspect[]
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [furnaces, batches, pieces, steps, stepOutbox, anneals, inspects] = await Promise.all([
    db.furnaces.toArray(),
    db.batches.toArray(),
    db.pieces.toArray(),
    db.steps.toArray(),
    db.stepOutbox.toArray(),
    db.anneals.toArray(),
    db.inspects.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    furnaces,
    batches,
    pieces,
    steps,
    stepOutbox,
    anneals,
    inspects,
  }
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.stepOutbox, db.anneals, db.inspects],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.stepOutbox.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
      ])
      await db.furnaces.bulkPut(snapshot.furnaces.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.batches.bulkPut(snapshot.batches.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.pieces.bulkPut(snapshot.pieces.map(normalizePiece))
      await db.steps.bulkPut(snapshot.steps.map(normalizeStep))
      if (Array.isArray(snapshot.stepOutbox)) {
        await db.stepOutbox.bulkPut(snapshot.stepOutbox.map((row) => ({ ...row, revision: ROW_REVISION })))
      }
      await db.anneals.bulkPut(snapshot.anneals.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.inspects.bulkPut(snapshot.inspects.map((row) => ({ ...row, revision: ROW_REVISION })))
    },
  )
  await reconcilePieces()
}

/** 兼容旧版（v2）存档：补齐作品挂起字段 */
function normalizePiece(row: Piece): Piece {
  return {
    ...row,
    suspended: typeof row.suspended === 'boolean' ? row.suspended : false,
    suspendReason: typeof row.suspendReason === 'string' ? row.suspendReason : '',
    revision: ROW_REVISION,
  }
}

/** 兼容旧版（v2）存档：缺窑号字段的工序按老记录只读保留，避免脏数据 */
function normalizeStep(row: Step): Step {
  const hasKiln = typeof row.furnaceCode === 'string' && row.furnaceCode !== ''
  return {
    ...row,
    furnaceId: typeof row.furnaceId === 'string' ? row.furnaceId : '',
    furnaceCode: hasKiln ? row.furnaceCode : '',
    capTempC: typeof row.capTempC === 'number' ? row.capTempC : 0,
    checkState: row.checkState === '超上限' ? '超上限' : '正常',
    checkedAt: typeof row.checkedAt === 'string' ? row.checkedAt : '',
    legacy: hasKiln ? row.legacy === true : true,
    revision: ROW_REVISION,
  }
}

export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.furnaces, db.batches, db.pieces, db.steps, db.stepOutbox, db.anneals, db.inspects],
    async () => {
      await Promise.all([
        db.furnaces.clear(),
        db.batches.clear(),
        db.pieces.clear(),
        db.steps.clear(),
        db.stepOutbox.clear(),
        db.anneals.clear(),
        db.inspects.clear(),
      ])
    },
  )
  await seedDatabase()
}

export async function countAll(): Promise<Record<string, number>> {
  const [furnaces, batches, pieces, steps, stepOutbox, anneals, inspects] = await Promise.all([
    db.furnaces.count(),
    db.batches.count(),
    db.pieces.count(),
    db.steps.count(),
    db.stepOutbox.count(),
    db.anneals.count(),
    db.inspects.count(),
  ])
  return { furnaces, batches, pieces, steps, stepOutbox, anneals, inspects }
}
