/**
 * 落账重试（技师侧）
 * 技师那份落账失败后按本侧重试，设备这边不受影响：
 * - 只重试技师侧的写入动作，绝不把设备侧写入放进同一事务；
 * - 超出重试次数仍失败时返回失败原因，由调用方标记「落账失败 · 待重试」，
 *   设备侧数据保持原样、不回滚。
 */

export interface PostResult {
  ok: boolean
  error: string
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 对单次落账动作做有限次重试（指数退避）。
 * 成功立即返回；全部尝试失败后返回最后一次错误信息。
 */
export async function postWithRetry(post: () => Promise<void>, attempts = 3, baseDelayMs = 120): Promise<PostResult> {
  let lastError = ''
  for (let i = 0; i < attempts; i += 1) {
    try {
      await post()
      return { ok: true, error: '' }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      if (i < attempts - 1) {
        await sleep(baseDelayMs * (i + 1))
      }
    }
  }
  return { ok: false, error: lastError === '' ? '落账失败' : lastError }
}
