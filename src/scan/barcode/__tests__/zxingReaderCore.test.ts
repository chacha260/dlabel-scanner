import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createZxingReaderCore, type TerminableWorker } from '../zxingReaderCore'

function fakeWorker(): TerminableWorker & { terminate: ReturnType<typeof vi.fn<() => void>> } {
  return { terminate: vi.fn<() => void>() }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createZxingReaderCore', () => {
  it('通常どおり result が来れば、対応する id の Promise だけが解決される', async () => {
    const worker = fakeWorker()
    const core = createZxingReaderCore(worker, { timeoutMs: 1000, maxConsecutiveErrors: 3 })

    const req1 = core.registerRequest()
    const req2 = core.registerRequest()
    core.handleResult(req1.id, [{ value: 'A', format: 'qr_code' }])

    await expect(req1.promise).resolves.toEqual([{ value: 'A', format: 'qr_code' }])
    // req2 はまだ解決されていないはず（タイムアウト前に確認するため、ここでは
    // then が同期的に呼ばれないことをレース無しで確認する）
    let req2Settled = false
    void req2.promise.then(() => {
      req2Settled = true
    })
    await Promise.resolve()
    expect(req2Settled).toBe(false)
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it('タイムアウトすると空配列で settle し、workerごと死亡扱いにして terminate() する', async () => {
    const worker = fakeWorker()
    const core = createZxingReaderCore(worker, { timeoutMs: 3000, maxConsecutiveErrors: 5 })

    const { promise } = core.registerRequest()
    expect(core.isDead()).toBe(false)

    vi.advanceTimersByTime(3000)
    await expect(promise).resolves.toEqual([])
    expect(core.isDead()).toBe(true)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('settle 済みのリクエストはタイムアウトしても何も起きない（clearTimeoutされている）', async () => {
    const worker = fakeWorker()
    const core = createZxingReaderCore(worker, { timeoutMs: 1000, maxConsecutiveErrors: 5 })

    const { id, promise } = core.registerRequest()
    core.handleResult(id, [])
    await expect(promise).resolves.toEqual([])

    vi.advanceTimersByTime(5000)
    expect(core.isDead()).toBe(false)
    expect(worker.terminate).not.toHaveBeenCalled()
  })

  it('worker の error / messageerror 相当（handleWorkerFailure）は即座に死亡扱いにし、待機中の全リクエストを空配列で解決する', async () => {
    const worker = fakeWorker()
    const core = createZxingReaderCore(worker, { timeoutMs: 5000, maxConsecutiveErrors: 5 })

    const req1 = core.registerRequest()
    const req2 = core.registerRequest()
    core.handleWorkerFailure()

    await expect(req1.promise).resolves.toEqual([])
    await expect(req2.promise).resolves.toEqual([])
    expect(core.isDead()).toBe(true)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })

  it('data.error 付きの result が連続閾値回に達すると、持続的失敗として死亡扱い＋通知が1回だけ呼ばれる', () => {
    const worker = fakeWorker()
    const onPersistentFailure = vi.fn()
    const core = createZxingReaderCore(worker, {
      timeoutMs: 5000,
      maxConsecutiveErrors: 3,
      onPersistentFailure,
    })

    const r1 = core.registerRequest()
    core.handleResult(r1.id, [], 'boom')
    expect(core.isDead()).toBe(false)
    expect(onPersistentFailure).not.toHaveBeenCalled()

    const r2 = core.registerRequest()
    core.handleResult(r2.id, [], 'boom')
    expect(core.isDead()).toBe(false)

    const r3 = core.registerRequest()
    core.handleResult(r3.id, [], 'boom')
    expect(core.isDead()).toBe(true)
    expect(onPersistentFailure).toHaveBeenCalledTimes(1)
    expect(worker.terminate).toHaveBeenCalledTimes(1)

    // 死亡後にさらに error 付き result が来ても、通知は再度呼ばれない
    const r4 = core.registerRequest()
    core.handleResult(r4.id, [], 'boom')
    expect(onPersistentFailure).toHaveBeenCalledTimes(1)
  })

  it('成功が1回でも挟まれば連続失敗カウントはリセットされる（散発的な失敗では死亡扱いにしない）', () => {
    const worker = fakeWorker()
    const onPersistentFailure = vi.fn()
    const core = createZxingReaderCore(worker, {
      timeoutMs: 5000,
      maxConsecutiveErrors: 2,
      onPersistentFailure,
    })

    for (let i = 0; i < 10; i += 1) {
      const errReq = core.registerRequest()
      core.handleResult(errReq.id, [], 'boom')
      const okReq = core.registerRequest()
      core.handleResult(okReq.id, [])
    }

    expect(core.isDead()).toBe(false)
    expect(onPersistentFailure).not.toHaveBeenCalled()
  })

  it('存在しない/既に処理済みの id を handleResult に渡しても例外を投げない', () => {
    const worker = fakeWorker()
    const core = createZxingReaderCore(worker, { timeoutMs: 1000, maxConsecutiveErrors: 3 })
    expect(() => core.handleResult(9999, [{ value: 'X', format: 'qr_code' }])).not.toThrow()
  })

  it('close() は待機中の全リクエストを空配列で解決してから terminate() し、複数回呼んでも terminate() は1回だけ', async () => {
    const worker = fakeWorker()
    const core = createZxingReaderCore(worker, { timeoutMs: 5000, maxConsecutiveErrors: 5 })

    const { promise } = core.registerRequest()
    core.close()
    core.close()

    await expect(promise).resolves.toEqual([])
    expect(worker.terminate).toHaveBeenCalledTimes(1)
    expect(core.isDead()).toBe(true)
  })

  it('死亡後に registerRequest() が呼ばれても、無駄なタイマーを登録せず即座に空配列で解決する', async () => {
    const worker = fakeWorker()
    const core = createZxingReaderCore(worker, { timeoutMs: 1000, maxConsecutiveErrors: 3 })
    core.close()

    const { promise } = core.registerRequest()
    await expect(promise).resolves.toEqual([])
    // タイマーが1本も残っていないこと（残っていれば何かとエラーになるはずだが、
    // ここでは進めても新たな terminate 等の副作用が起きないことで間接的に確認する）
    vi.advanceTimersByTime(10000)
    expect(worker.terminate).toHaveBeenCalledTimes(1)
  })
})
