import { describe, expect, it } from 'vitest'
import { parsePaddleDict } from '../dict'

describe('parsePaddleDict', () => {
  it('CRLF区切りの各行から\\rを取り除いて配列にする', () => {
    const text = 'a\r\nb\r\nc\r\n'
    expect(parsePaddleDict(text)).toEqual(['a', 'b', 'c'])
  })

  it('末尾の空行（ファイルが改行で終わることによる余分な要素）を含めない', () => {
    // 実物のppocrv5_dict.txtと同じ形（各行末がCRLF、末尾にも改行がある）
    const text = '一\r\n二\r\n三\r\n'
    const dict = parsePaddleDict(text)
    expect(dict.length).toBe(3)
    expect(dict).toEqual(['一', '二', '三'])
  })

  it('LFのみの区切りでも正しく分割する', () => {
    expect(parsePaddleDict('x\ny\nz')).toEqual(['x', 'y', 'z'])
  })

  it('空文字列を渡すと空配列を返す（例外を投げない）', () => {
    expect(parsePaddleDict('')).toEqual([])
  })

  it('中間に空行があっても（本来無いはずだが）読み飛ばす', () => {
    expect(parsePaddleDict('a\r\n\r\nb\r\n')).toEqual(['a', 'b'])
  })
})
