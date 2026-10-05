/**
 * 技师侧落账重试队列（StepOutbox）
 * 吹制技师把工序落进自己的台账时，若本地写入失败（如浏览器配额 / 事务异常），
 * 先落到这张「待重试」表并按本侧重试；设备侧（窑炉台账）完全独立、不受影响。
 * 重试成功后从队列移除。队列与设备表分表，保证两边账本互不连坐。
 */

/** 待重试动作：新增 / 更新 / 删除一道工序 */
export type StepOutboxOp = 'put' | 'delete'

export const STEP_OUTBOX_OP_OPTIONS: StepOutboxOp[] = ['put', 'delete']

export interface StepOutbox {
  id: string
  /** 目标工序 id（put 为其主键，delete 为待删工序 id） */
  stepId: string
  /** put 时携带的完整工序行；delete 时为空 */
  payload: string
  /** 动作类型 */
  op: StepOutboxOp
  /** 已尝试次数 */
  attempts: number
  /** 最近一次失败原因 */
  lastError: string
  /** 首次入队时间 ISO */
  createdAt: string
  /** 最近一次尝试时间 ISO */
  updatedAt: string
  revision: number
}
