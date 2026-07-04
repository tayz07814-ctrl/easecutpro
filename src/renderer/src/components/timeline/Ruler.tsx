// Time ruler. Adaptive tick density: majors carry mm:ss labels, minors fill in
// between. Positions are seconds*zoom, so it stays pixel-aligned with clips.

import { chooseTickSeconds, labelSeconds } from './geometry'

export function Ruler({ width, zoom }: { width: number; zoom: number }): JSX.Element {
  const step = chooseTickSeconds(zoom)
  const totalSec = width / zoom
  const minorStep = step / 5

  const ticks: JSX.Element[] = []
  for (let s = 0, i = 0; s <= totalSec + step; s += minorStep, i++) {
    const isMajor = i % 5 === 0
    const x = s * zoom
    if (isMajor) {
      ticks.push(
        <div key={`M${i}`} className="ec-tl-tick major" style={{ left: x }}>
          <span className="ec-tl-tick-label">{labelSeconds(s)}</span>
        </div>
      )
    } else {
      ticks.push(<div key={`m${i}`} className="ec-tl-tick minor" style={{ left: x }} />)
    }
  }
  return (
    <div className="ec-tl-ruler" style={{ width }}>
      {ticks}
    </div>
  )
}
