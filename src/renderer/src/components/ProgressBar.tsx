import { useStore } from '../store'
import { useSmoothProgress } from '../useSmoothProgress'

export default function ProgressBar(): JSX.Element | null {
  const job = useStore((s) => s.job)
  const shown = useSmoothProgress(job.active, job.percent)
  if (!job.active && !job.message) return null
  return (
    <div className={'statusbar' + (job.active ? ' active' : '')}>
      {job.active && (
        <div className="progress">
          <div className="bar smooth" style={{ width: `${shown}%` }} />
        </div>
      )}
      <span className="status-msg">
        {job.message ?? ''} {job.active ? `(${Math.round(shown)}%)` : ''}
      </span>
    </div>
  )
}
