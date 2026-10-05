/**
 * 窑炉 ↔ 工序 对账与重算（纯函数，无 Dexie 依赖）
 * - 按归属为工序回填挂账窑炉（step → piece → batch → furnace）
 * - 两边按窑炉对账：工序上写的窑号跟设备那份对不上就把这一件挂起
 * - 窑炉最高温度改动后，对还没推进的工序重算（刷新上限快照，超出则按下限卡住）
 * 已完成（烧成）的老工序一律不重算、不回改，留着原样。
 */
import type { Furnace } from '../types/furnace'
import type { GlassBatch } from '../types/batch'
import type { Piece } from '../types/piece'
import type { Step } from '../types/step'

/** 工序挂账窑炉快照 */
export interface StepFurnaceRef {
  furnaceId: string
  furnaceCode: string
  maxTempC: number
}

/** 按归属为工序找窑炉：step → piece → batch → furnace，任一缺失返回 null（老记录只读） */
export function attributeStepFurnace(
  step: Pick<Step, 'pieceId'>,
  pieceById: Map<string, Piece>,
  batchById: Map<string, GlassBatch>,
  furnaceById: Map<string, Furnace>,
): StepFurnaceRef | null {
  const piece = pieceById.get(step.pieceId)
  if (piece === undefined) return null
  const batch = batchById.get(piece.batchId)
  if (batch === undefined) return null
  const furnace = furnaceById.get(batch.furnaceId)
  if (furnace === undefined) return null
  return { furnaceId: furnace.id, furnaceCode: furnace.code, maxTempC: furnace.maxTempC }
}

/** 单条窑号不一致明细 */
export interface StepMismatch {
  stepId: string
  seq: number
  name: string
  /** 工序上写的窑号（技师侧） */
  furnaceCode: string
  /** 设备侧当前窑号（空串表示窑炉已删除） */
  equipmentCode: string
  reason: string
}

/** 单件作品对账结果 */
export interface PieceReconcile {
  pieceId: string
  suspended: boolean
  reason: string
  mismatches: StepMismatch[]
}

/** 对账：某件作品的工序窑号与设备侧窑炉台账逐一比对，不一致即挂起 */
export function reconcilePiece(pieceId: string, steps: Step[], furnaces: Furnace[]): PieceReconcile {
  const furnaceById = new Map(furnaces.map((row) => [row.id, row]))
  const list = steps
    .filter((row) => row.pieceId === pieceId)
    .slice()
    .sort((a, b) => a.seq - b.seq)
  const mismatches: StepMismatch[] = []
  for (const step of list) {
    // 升级前未挂窑炉的老记录不参与对账（只读）
    if (step.furnaceId === '') continue
    const furnace = furnaceById.get(step.furnaceId)
    const equipmentCode = furnace?.code ?? ''
    if (step.furnaceCode !== equipmentCode) {
      mismatches.push({
        stepId: step.id,
        seq: step.seq,
        name: step.name,
        furnaceCode: step.furnaceCode,
        equipmentCode,
        reason:
          equipmentCode === ''
            ? `第 ${step.seq} 道「${step.name}」挂的窑炉（${step.furnaceCode}）在设备台账中已删除`
            : `第 ${step.seq} 道「${step.name}」工序窑号 ${step.furnaceCode} 与设备侧 ${equipmentCode} 不一致`,
      })
    }
  }
  const suspended = mismatches.length > 0
  const reason = suspended
    ? `工序与设备按窑炉对账不一致：${mismatches
        .map((m) => `第${m.seq}道 ${m.furnaceCode} ≠ ${m.equipmentCode === '' ? '已删' : m.equipmentCode}`)
        .join('；')}`
    : ''
  return { pieceId, suspended, reason, mismatches }
}

/** 批量对账：返回 pieceId → 对账结果 */
export function reconcileAll(pieces: Piece[], steps: Step[], furnaces: Furnace[]): Map<string, PieceReconcile> {
  const map = new Map<string, PieceReconcile>()
  for (const piece of pieces) {
    map.set(piece.id, reconcilePiece(piece.id, steps, furnaces))
  }
  return map
}

/** 重算结果 */
export interface RecomputeResult {
  step: Step
  /** 是否参与重算（未推进且挂的是该窑炉） */
  recomputed: boolean
  /** 是否被按下限卡住（温度下调） */
  clamped: boolean
}

/**
 * 窑炉最高温度改动后，对未推进（非「已完成」）工序重算：
 * 刷新上限快照；若记录温度超出新上限则按新上限卡住。
 * 已完成（烧成）工序原样返回，不重算。
 */
export function recomputeStepForFurnace(step: Step, furnace: Furnace): RecomputeResult {
  if (step.state === '已完成') return { step, recomputed: false, clamped: false }
  if (step.furnaceId !== furnace.id) return { step, recomputed: false, clamped: false }
  const next: Step = { ...step, maxTempC: furnace.maxTempC }
  let clamped = false
  if (next.tempC > furnace.maxTempC) {
    next.tempC = furnace.maxTempC
    next.tempAdjusted = true
    clamped = true
  }
  return { step: next, recomputed: true, clamped }
}
