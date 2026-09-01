// カメラ取得解像度（画質）のプリセット。DOM には依存しない純粋なデータのみを持つ。
//
// 「枠内のみ」ON時のクロップ最適化（scan/barcode/crop.ts）だけでも通常はCPU負荷を
// 十分下げられるが、端末やバッテリー状況によってはそれでも重いことがある。
// その保険として、そもそも getUserMedia に要求する解像度自体を下げられるように
// しておく。ただし解像度を下げると細いバーが読めなくなる退行そのものなので、
// 既定は 'max'（今回の精度改善を検証したときと同じ挙動）にする。

export type CaptureQuality = 'max' | 'fhd' | 'hd'

export type CaptureQualityConstraint = { width: number; height: number }

// ideal はあくまで「できれば」の指定であり、端末が対応していなくても失敗しない
// （小さい端末では ideal 通りにならず、それより小さい値になる）。
export const CAPTURE_QUALITY_CONSTRAINTS: Record<CaptureQuality, CaptureQualityConstraint> = {
  max: { width: 3840, height: 2160 },
  fhd: { width: 1920, height: 1080 },
  hd: { width: 1280, height: 720 },
}

// 今回の精度改善（720px一律ダウンスケールの撤廃）を退行させないため、
// 既定は必ず 'max'（端末の最大解像度）にする。
export const DEFAULT_CAPTURE_QUALITY: CaptureQuality = 'max'

export const CAPTURE_QUALITY_OPTIONS: { value: CaptureQuality; label: string }[] = [
  { value: 'max', label: '最大' },
  { value: 'fhd', label: '標準' },
  { value: 'hd', label: '軽量' },
]
