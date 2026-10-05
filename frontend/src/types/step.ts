/**
 * 吹制工序（Step）
 * 逐道记录温度、时长与操作人；任一前序未完成则阻断进入退火排位。
 * 每道工序都挂上「当时那台窑炉」，并快照窑号与当时的温度上限，
 * 作为设备侧（窑炉台账）与技师侧（工序台账）按窑炉对账的凭据。
 */

/** 工序名称 */
export type StepName = '取料' | '吹制' | '塑形' | '开模' | '收口'

/** 工序执行状态 */
export type StepState = '未开始' | '进行中' | '已完成'

/**
 * 工序温度核对结果
 * - 正常：温度未超过当时窑炉上限
 * - 超上限：温度超过当时窑炉上限，该道被退回，需改温度或换窑后重记
 */
export type StepCheckState = '正常' | '超上限'

export const STEP_NAME_OPTIONS: StepName[] = ['取料', '吹制', '塑形', '开模', '收口']
export const STEP_STATE_OPTIONS: StepState[] = ['未开始', '进行中', '已完成']
export const STEP_CHECK_OPTIONS: StepCheckState[] = ['正常', '超上限']

export interface Step {
  id: string
  /** 所属作品 */
  pieceId: string
  /** 工序序号，从 1 开始 */
  seq: number
  /** 工序名称 */
  name: StepName
  /** 工序温度（℃） */
  tempC: number
  /** 时长（分钟） */
  durationMin: number
  /** 操作人 */
  operator: string
  /** 备注 */
  remark: string
  /** 工序状态 */
  state: StepState
  /** 当时所挂窑炉 id（设备台账侧主键） */
  furnaceId: string
  /** 当时所挂窑号快照（如 KILN-01），与设备侧窑号对账用 */
  furnaceCode: string
  /** 记这道工序时窑炉的最高温度上限（℃），用于把温度卡在当时上限上 */
  capTempC: number
  /** 温度核对结果（按当时窑炉上限） */
  checkState: StepCheckState
  /** 最近一次核对时间 ISO */
  checkedAt: string
  /**
   * 旧数据标记：v3 升级前的老工序未记窑号，按归属回填；
   * 归属链（作品 → 料液批次 → 窑炉）断了填不了的，置为 true 只读保留。
   */
  legacy: boolean
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑吹制工序的表单草稿 */
export interface StepDraft {
  pieceId: string
  seq: number
  name: StepName
  tempC: number
  durationMin: number
  operator: string
  remark: string
  state: StepState
  /** 本道工序所挂窑炉 */
  furnaceId: string
}
