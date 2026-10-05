/**
 * 吹制工序（Step）
 * 逐道记录温度、时长与操作人；任一前序未完成则阻断进入退火排位。
 */

/** 工序名称 */
export type StepName = '取料' | '吹制' | '塑形' | '开模' | '收口'

/** 工序执行状态 */
export type StepState = '未开始' | '进行中' | '已完成'

export const STEP_NAME_OPTIONS: StepName[] = ['取料', '吹制', '塑形', '开模', '收口']
export const STEP_STATE_OPTIONS: StepState[] = ['未开始', '进行中', '已完成']

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
  /** 挂账窑炉（当时那台）；升级前未记窑号的老记录为空串 */
  furnaceId: string
  /** 窑号快照（入账时窑炉的 code），用于与设备侧按窑炉对账 */
  furnaceCode: string
  /** 入账时窑炉上限温度（℃）快照；温度按此卡住，已完成工序不随后续改动重算 */
  maxTempC: number
  /** 落账状态：true 已落账 / false 落账失败待重试（仅技师侧重试，不触碰设备侧） */
  posted: boolean
  /** 最近一次落账失败原因 */
  postError: string
  /** 窑炉上限改动后被重算调整过温度（仅未推进工序） */
  tempAdjusted: boolean
  /** 升级前遗留、按归属回填不到窑炉的老记录（只读） */
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
  /** 挂账窑炉（当时那台） */
  furnaceId: string
}
