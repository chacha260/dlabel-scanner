// draft.ts の単体テスト。
//
// このプロジェクトの vitest environment は 'node' のため、実際の IndexedDB は
// 使えない（ブラウザ専用 API のため、依存を追加せずに node で偽装することもできない）。
// そのため、下書きの保存/取得/削除 IO については '../db' の getDb を
// vi.mock で単純な Map ベースの疑似ストアに差し替えてテストする
// （追加パッケージなし、vitest 標準のモック機能のみを使用）。
// これとは別に、IndexedDB に依存しない純粋な判定ロジック
// （isDraftNonEmpty / countDraftScans / resolveDraftProfile /
//  registerDraftFlush・flushPendingDraft の橋渡し）は、モックなしでも
// そのまま検証できる。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Profile, RawScan } from '../../parse/types'

const stores = new Map<string, Map<string, unknown>>()

function storeFor(name: string): Map<string, unknown> {
  let s = stores.get(name)
  if (!s) {
    s = new Map()
    stores.set(name, s)
  }
  return s
}

vi.mock('../db', () => ({
  DRAFT_ID: 'current',
  getDb: async () => ({
    get: async (storeName: string, key: string) => storeFor(storeName).get(key),
    put: async (storeName: string, value: { id: string }, key?: string) => {
      storeFor(storeName).set(key ?? value.id, value)
    },
    delete: async (storeName: string, key: string) => {
      storeFor(storeName).delete(key)
    },
  }),
}))

import {
  clearDraft,
  countDraftScans,
  DRAFT_ID,
  flushPendingDraft,
  isDraftNonEmpty,
  loadDraft,
  registerDraftFlush,
  resolveDraftProfile,
  saveDraft,
} from '../draft'

function scan(value: string): RawScan {
  return { value, source: 'barcode', at: Date.now() }
}

function makeProfile(id: string): Profile {
  return {
    id,
    name: `プロファイル ${id}`,
    splitMode: 'perBarcode',
    delimiters: [],
    collapseSpaces: false,
    fields: [],
    completeWhen: 'allRequired',
  }
}

beforeEach(() => {
  stores.clear()
  registerDraftFlush(null)
})

describe('isDraftNonEmpty', () => {
  it('rawScans / fieldOverrides どちらも空なら false', () => {
    expect(isDraftNonEmpty({ rawScans: [], fieldOverrides: {} })).toBe(false)
  })

  it('rawScans があれば true', () => {
    expect(isDraftNonEmpty({ rawScans: [scan('A')], fieldOverrides: {} })).toBe(true)
  })

  it('fieldOverrides があれば true', () => {
    expect(isDraftNonEmpty({ rawScans: [], fieldOverrides: { part_no: scan('A') } })).toBe(true)
  })
})

describe('countDraftScans', () => {
  it('rawScans 数と fieldOverrides 数を合算する', () => {
    const count = countDraftScans({
      rawScans: [scan('A'), scan('B')],
      fieldOverrides: { part_no: scan('C') },
    })
    expect(count).toBe(3)
  })

  it('空なら 0', () => {
    expect(countDraftScans({ rawScans: [], fieldOverrides: {} })).toBe(0)
  })
})

describe('resolveDraftProfile', () => {
  it('該当するプロファイルを返す', () => {
    const profiles = [makeProfile('p1'), makeProfile('p2')]
    expect(resolveDraftProfile({ profileId: 'p2' }, profiles)?.id).toBe('p2')
  })

  it('プロファイルが削除済みなら undefined を返す', () => {
    const profiles = [makeProfile('p1')]
    expect(resolveDraftProfile({ profileId: 'deleted-id' }, profiles)).toBeUndefined()
  })
})

describe('saveDraft / loadDraft / clearDraft', () => {
  it('保存前は undefined を返す', async () => {
    expect(await loadDraft()).toBeUndefined()
  })

  it('保存した下書きを取得できる（id は常に固定値になる）', async () => {
    await saveDraft({ profileId: 'p1', rawScans: [scan('A')], fieldOverrides: {}, updatedAt: 1 })
    const loaded = await loadDraft()
    expect(loaded?.id).toBe(DRAFT_ID)
    expect(loaded?.profileId).toBe('p1')
    expect(loaded?.rawScans).toHaveLength(1)
  })

  it('clearDraft で削除できる', async () => {
    await saveDraft({ profileId: 'p1', rawScans: [scan('A')], fieldOverrides: {}, updatedAt: 1 })
    await clearDraft()
    expect(await loadDraft()).toBeUndefined()
  })

  it('保存し直すと上書きされる（常に単一レコードのみ保持する）', async () => {
    await saveDraft({ profileId: 'p1', rawScans: [scan('A')], fieldOverrides: {}, updatedAt: 1 })
    await saveDraft({ profileId: 'p2', rawScans: [], fieldOverrides: {}, updatedAt: 2 })
    const loaded = await loadDraft()
    expect(loaded?.profileId).toBe('p2')
  })
})

describe('registerDraftFlush / flushPendingDraft', () => {
  it('未登録なら何もせず解決する', async () => {
    await expect(flushPendingDraft()).resolves.toBeUndefined()
  })

  it('登録した flush 関数が呼ばれる', async () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    registerDraftFlush(fn)
    await flushPendingDraft()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('null を登録すると解除される', async () => {
    const fn = vi.fn().mockResolvedValue(undefined)
    registerDraftFlush(fn)
    registerDraftFlush(null)
    await flushPendingDraft()
    expect(fn).not.toHaveBeenCalled()
  })
})
