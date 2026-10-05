/**
 * 热工计算工具
 * - 退火曲线段时长换算（升温 / 保温 / 缓冷）
 * - 窑位占用判重（同一窑位时间窗重叠检测）
 * - 温度单位换算（℃ ↔ ℉）
 * - 工艺温度区间与设计尺寸校验
 */
import type { Anneal, CurveSeg } from '../types/anneal'
import type { Craft } from '../types/piece'
import type { Furnace, FurnaceState } from '../types/furnace'
import type { Step, StepCheckState } from '../types/step'

/** 保留 1 位小数 */
export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 保留 2 位小数 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** 摄氏度 → 华氏度 */
export function cToF(c: number): number {
  return round1((c * 9) / 5 + 32)
}

/** 华氏度 → 摄氏度 */
export function fToC(f: number): number {
  return round1(((f - 32) * 5) / 9)
}

/** 退火曲线段参数：起止温度与速率 */
export interface CurveSegment {
  seg: CurveSeg
  startC: number
  endC: number
  /** 升降温速率（℃/小时）；保温段为 0 */
  rateCPerHour: number
  /** 保温段的基准保温时长（小时，按 5mm 壁厚计） */
  holdHoursPer5mm: number
  hint: string
}

/** 退火曲线定义（钠钙玻璃常规退火区间） */
export const ANNEAL_CURVE: Record<CurveSeg, CurveSegment> = {
  升温: {
    seg: '升温',
    startC: 20,
    endC: 560,
    rateCPerHour: 120,
    holdHoursPer5mm: 0,
    hint: '从室温以 120 ℃/h 缓慢升温至 560 ℃ 退火点，避免热冲击。',
  },
  保温: {
    seg: '保温',
    startC: 560,
    endC: 560,
    rateCPerHour: 0,
    holdHoursPer5mm: 1.2,
    hint: '在 560 ℃ 退火点保温，每 5 mm 壁厚保温 1.2 小时以消除内应力。',
  },
  缓冷: {
    seg: '缓冷',
    startC: 560,
    endC: 60,
    rateCPerHour: 40,
    holdHoursPer5mm: 0,
    hint: '以 40 ℃/h 缓慢降温至 60 ℃ 以下再出窑，快速降温会造成裂纹。',
  },
}

/**
 * 曲线段时长换算（小时）
 * 升温 / 缓冷按温差与速率换算；保温按壁厚换算（每 5 mm 保温 1.2 小时）。
 */
export function segmentHours(seg: CurveSeg, wallThicknessMm: number): number {
  const curve = ANNEAL_CURVE[seg]
  if (seg === '保温') {
    const thickness = Math.max(1, wallThicknessMm)
    return round1((thickness / 5) * curve.holdHoursPer5mm)
  }
  const delta = Math.abs(curve.endC - curve.startC)
  if (curve.rateCPerHour <= 0) return 0
  return round1(delta / curve.rateCPerHour)
}

/** 一件作品的完整退火时长（三段合计，小时） */
export function totalAnnealHours(wallThicknessMm: number): number {
  return round1(
    segmentHours('升温', wallThicknessMm) + segmentHours('保温', wallThicknessMm) + segmentHours('缓冷', wallThicknessMm),
  )
}

/** 把小时数格式化为「x 小时 y 分钟」 */
export function formatHours(hours: number): string {
  const total = Math.max(0, Math.round(hours * 60))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} 分钟`
  if (m === 0) return `${h} 小时`
  return `${h} 小时 ${m} 分钟`
}

/** 解析 ISO / datetime-local 字符串为时间戳；非法返回 NaN */
export function parseAt(value: string): number {
  if (value === '') return Number.NaN
  const stamp = new Date(value).getTime()
  return Number.isNaN(stamp) ? Number.NaN : stamp
}

/** 时间窗：[入窑, 出炉]；未出炉时以入窑 + 预计时长作为临时出炉时间 */
export function annealWindow(row: Pick<Anneal, 'inAt' | 'outAt' | 'curveSeg'>, wallThicknessMm: number): [number, number] {
  const start = parseAt(row.inAt)
  if (Number.isNaN(start)) return [Number.NaN, Number.NaN]
  const end = parseAt(row.outAt)
  if (!Number.isNaN(end) && end > start) return [start, end]
  return [start, start + segmentHours(row.curveSeg, wallThicknessMm) * 3600 * 1000]
}

/** 两个时间窗是否重叠 */
export function windowsOverlap(a: [number, number], b: [number, number]): boolean {
  if (Number.isNaN(a[0]) || Number.isNaN(b[0])) return false
  return a[0] < b[1] && b[0] < a[1]
}

export interface SlotConflict {
  conflict: boolean
  /** 冲突的既有退火记录 */
  withPieceId: string
  withAnnealId: string
  message: string
}

/**
 * 窑位占用判重：同一窑位、时间窗重叠即为冲突。
 * excludeAnnealId 用于编辑场景排除自身。
 */
export function checkSlotConflict(
  existing: Anneal[],
  candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  wallThicknessOf: (pieceId: string) => number,
  excludeAnnealId = '',
): SlotConflict {
  const ownThickness = wallThicknessOf(candidate.pieceId)
  const ownWindow = annealWindow(candidate, ownThickness)

  for (const row of existing) {
    if (row.id === excludeAnnealId) continue
    if (row.kilnSlot !== candidate.kilnSlot) continue
    const otherWindow = annealWindow(row, wallThicknessOf(row.pieceId))
    if (windowsOverlap(ownWindow, otherWindow)) {
      return {
        conflict: true,
        withPieceId: row.pieceId,
        withAnnealId: row.id,
        message: `窑位 ${candidate.kilnSlot} 在该时间窗内已被占用（${row.inAt} 起的 ${row.curveSeg} 段），请更换窑位或调整时间。`,
      }
    }
  }
  return { conflict: false, withPieceId: '', withAnnealId: '', message: '' }
}

/** 生成某台退火窑的窑位列表 */
export function kilnSlots(kilnCode: string): string[] {
  const rows = ['A', 'B', 'C']
  const cols = [1, 2, 3]
  const list: string[] = []
  rows.forEach((row) => {
    cols.forEach((col) => {
      list.push(`${kilnCode}-${row}${col}`)
    })
  })
  return list
}

/** 工艺对应的适宜成型温度区间（℃） */
export const CRAFT_TEMP_RANGE: Record<Craft, { min: number; max: number; hint: string }> = {
  吹制: { min: 900, max: 1200, hint: '吹制需在 900–1200 ℃ 的高温区间快速完成，温度过低玻璃会硬化。' },
  铸造: { min: 800, max: 1150, hint: '铸造（窑铸）在 800–1150 ℃ 区间浇注，随后随窑缓冷。' },
  热塑: { min: 700, max: 1000, hint: '热塑（灯工）在 700–1000 ℃ 区间塑形，注意反复回火避免炸裂。' },
}

export interface TempCheck {
  ok: boolean
  message: string
}

/** 工序温度合理性校验：不得超窑炉上限，且应落在工艺区间附近 */
export function checkStepTemp(tempC: number, maxTempC: number, craft: Craft): TempCheck {
  const range = CRAFT_TEMP_RANGE[craft]
  if (tempC > maxTempC) {
    return { ok: false, message: `工序温度 ${tempC} ℃ 超过所选窑炉上限 ${maxTempC} ℃，无法执行。` }
  }
  if (tempC < range.min - 120 || tempC > range.max + 120) {
    return {
      ok: false,
      message: `工序温度 ${tempC} ℃ 明显偏离「${craft}」的适宜区间 ${range.min}–${range.max} ℃。${range.hint}`,
    }
  }
  return { ok: true, message: `工序温度 ${tempC} ℃ 落在「${craft}」的合理区间内。` }
}

/**
 * 工序温度的「硬上限」校验：只按当时窑炉上限卡温度。
 * 超过上限只退回这一道（返回 ok=false），不影响已烧成的老工序。
 */
export function checkStepCap(tempC: number, capTempC: number, furnaceCode?: string): TempCheck {
  if (tempC > capTempC) {
    const where = furnaceCode === undefined || furnaceCode === '' ? '' : `（窑炉 ${furnaceCode}）`
    return {
      ok: false,
      message: `工序温度 ${tempC} ℃ 超过当时窑炉上限 ${capTempC} ℃${where}，该道退回，请调低温度或更换窑炉后重记。`,
    }
  }
  return { ok: true, message: `工序温度 ${tempC} ℃ 未超过当时窑炉上限 ${capTempC} ℃。` }
}

/**
 * 窑炉运行态提示：窑炉降成保温或停窑检修后，继续往里记温度需格外核对。
 * 仅提示，不阻断（温度仍由上限硬卡与对账兜底）。
 */
export function furnaceStateNotice(state: FurnaceState): TempCheck | null {
  if (state === '保温') {
    return { ok: true, message: '该窑已降为保温：可记录温度，请按保温工况核对，避免出炉后与设备台账对不上。' }
  }
  if (state === '停窑') {
    return {
      ok: false,
      message: '该窑已停窑检修：设备台账显示不可作业，请确认是否改挂其它在役窑炉后再记这一道。',
    }
  }
  if (state === '升温') {
    return { ok: true, message: '该窑正在升温：请确认温度已达到作业区间再记这一道。' }
  }
  return null
}

/** 窑炉是否处于可正常作业状态 */
export function isFurnaceOperable(state: FurnaceState): boolean {
  return state === '运行' || state === '保温'
}

/** 重算后一道工序的落库变更 */
export interface StepRecalcChange {
  stepId: string
  pieceId: string
  furnaceCode: string
  capTempC: number
  checkState: StepCheckState
}

/**
 * 窑炉最高温度改动后的「未推进工序重算」。
 * 只重算挂在这台窑上、尚未推进到「已完成」的工序；已烧成的老工序原样保留。
 * 以新上限重新卡温度，刷新核对结果与上限快照；返回需要落库的变更清单（纯函数，不写库）。
 */
export function recalcStepsForFurnace(
  steps: Step[],
  furnace: Pick<Furnace, 'id' | 'code' | 'maxTempC'>,
): StepRecalcChange[] {
  const changes: StepRecalcChange[] = []
  steps.forEach((step) => {
    if (step.legacy) return // 填不了窑号的老记录只读，不参与重算
    if (step.furnaceId !== furnace.id) return
    if (step.state === '已完成') return // 烧成的老工序留着原样
    changes.push({
      stepId: step.id,
      pieceId: step.pieceId,
      furnaceCode: furnace.code,
      capTempC: furnace.maxTempC,
      checkState: step.tempC > furnace.maxTempC ? '超上限' : '正常',
    })
  })
  return changes
}

/* ------------------------------ 按窑炉对账 ------------------------------ */

/** 单道工序的对账结果 */
export interface ReconcileStepIssue {
  stepId: string
  pieceId: string
  seq: number
  name: Step['name']
  /** 工序上写的窑号（技师侧快照） */
  stepFurnaceCode: string
  /** 设备台账此刻的窑号；窑炉已删除时为空串 */
  ledgerCode: string
  kind: '窑号不符' | '窑炉缺失'
}

/** 每台窑炉的对账行 */
export interface FurnaceReconcileRow {
  furnaceId: string
  furnaceCode: string
  state: FurnaceState
  maxTempC: number
  /** 挂在该窑的工序道数（不含填不了窑号的老记录） */
  stepCount: number
  /** 其中温度超过当时上限的道数 */
  overLimitCount: number
  /** 窑号对不上的道数 */
  mismatchCount: number
  /** 受对账牵连、被挂起的作品数 */
  suspendedPieceCount: number
  issues: ReconcileStepIssue[]
}

/** 全量对账结果 */
export interface ReconcileResult {
  rows: FurnaceReconcileRow[]
  /** 窑炉已删除、工序仍挂着它的孤儿记录（工序上的窑号在设备台账已不存在） */
  orphans: ReconcileStepIssue[]
  /** 每件作品是否挂起及原因（只列有工序的作品） */
  pieceStatus: Array<{ pieceId: string; suspended: boolean; reason: string }>
  /** 被挂起作品总数 */
  suspendedCount: number
}

/**
 * 两边按窑炉对账：
 * 工序上写的窑号（furnaceCode 快照 + furnaceId）与设备台账那份对不上，
 * 就把这一件作品挂起。窑炉已删除同样视为对不上。
 * 纯函数：不改数据，只产出对账结论，由存储层据此回写挂起标记。
 */
export function reconcileByFurnace(
  furnaces: Furnace[],
  steps: Step[],
): ReconcileResult {
  const furnaceById = new Map(furnaces.map((furnace) => [furnace.id, furnace]))
  const activeSteps = steps.filter((step) => !step.legacy && step.furnaceId !== '')

  // 每件作品收集对账问题
  const issuesByPiece = new Map<string, ReconcileStepIssue[]>()
  const pushIssue = (issue: ReconcileStepIssue): void => {
    const list = issuesByPiece.get(issue.pieceId) ?? []
    list.push(issue)
    issuesByPiece.set(issue.pieceId, list)
  }

  const rows: FurnaceReconcileRow[] = furnaces.map((furnace) => {
    const own = activeSteps.filter((step) => step.furnaceId === furnace.id)
    const issues: ReconcileStepIssue[] = []
    own.forEach((step) => {
      if (step.furnaceCode !== furnace.code) {
        issues.push({
          stepId: step.id,
          pieceId: step.pieceId,
          seq: step.seq,
          name: step.name,
          stepFurnaceCode: step.furnaceCode,
          ledgerCode: furnace.code,
          kind: '窑号不符',
        })
      }
    })
    issues.forEach(pushIssue)
    const overLimit = own.filter((step) => step.checkState === '超上限').length
    return {
      furnaceId: furnace.id,
      furnaceCode: furnace.code,
      state: furnace.state,
      maxTempC: furnace.maxTempC,
      stepCount: own.length,
      overLimitCount: overLimit,
      mismatchCount: issues.length,
      suspendedPieceCount: 0,
      issues,
    }
  })

  // 窑炉缺失：工序挂的 furnaceId 在设备台账已不存在
  const orphans: ReconcileStepIssue[] = []
  activeSteps.forEach((step) => {
    if (!furnaceById.has(step.furnaceId)) {
      orphans.push({
        stepId: step.id,
        pieceId: step.pieceId,
        seq: step.seq,
        name: step.name,
        stepFurnaceCode: step.furnaceCode,
        ledgerCode: '',
        kind: '窑炉缺失',
      })
    }
  })
  orphans.forEach(pushIssue)

  // 有工序的作品逐一判定挂起
  const pieceIds = Array.from(new Set(activeSteps.map((step) => step.pieceId)))
  const pieceStatus = pieceIds.map((pieceId) => {
    const issues = issuesByPiece.get(pieceId) ?? []
    if (issues.length === 0) return { pieceId, suspended: false, reason: '' }
    const codes = Array.from(new Set(issues.map((issue) => issue.stepFurnaceCode || '（空窑号）')))
    const reason =
      `工序窑号与设备台账对不上（${issues.length} 道：${codes.join(' / ')}），` +
      '该件已挂起，请核对窑号或改挂窑炉后重新对账。'
    return { pieceId, suspended: true, reason }
  })

  const suspendedSet = new Set(pieceStatus.filter((item) => item.suspended).map((item) => item.pieceId))
  rows.forEach((row) => {
    const pieces = new Set(row.issues.map((issue) => issue.pieceId).filter((id) => suspendedSet.has(id)))
    row.suspendedPieceCount = pieces.size
  })

  return { rows, orphans, pieceStatus, suspendedCount: suspendedSet.size }
}

/** 设计尺寸比例校验：壁厚与高度需匹配 */
export function checkDesign(heightMm: number, wallThicknessMm: number): TempCheck {
  if (heightMm <= 0) return { ok: false, message: '设计高度必须大于 0。' }
  if (wallThicknessMm <= 0) return { ok: false, message: '壁厚必须大于 0。' }
  if (wallThicknessMm >= heightMm / 8) {
    return { ok: false, message: `壁厚 ${wallThicknessMm} mm 相对设计高度 ${heightMm} mm 偏厚，成型与退火难度都会显著上升。` }
  }
  if (wallThicknessMm < 1.5) {
    return { ok: false, message: `壁厚 ${wallThicknessMm} mm 过薄（建议 ≥ 1.5 mm），退火时极易变形。` }
  }
  return { ok: true, message: `设计尺寸比例合理：高 ${heightMm} mm / 壁厚 ${wallThicknessMm} mm。` }
}

/** 料液剩余量阈值（kg），低于该值提示补料 */
export const LOW_REMAIN_KG = 60

/** 是否低于补料阈值 */
export function isLowRemain(remainKg: number): boolean {
  return remainKg < LOW_REMAIN_KG
}
