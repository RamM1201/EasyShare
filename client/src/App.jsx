import { useEffect, useState } from 'react';

const SIGNALING_SERVER_URL =
  import.meta.env.VITE_SIGNALING_SERVER_URL || 'http://localhost:5000';

/**
 * Stage 1 placeholder.
 *
 * This component just confirms the frontend can reach the signaling
 * server's REST health check. Stage 3 will replace this with the real
 * drag-and-drop / "create room" / "join room" UI.
 */
function App() {
  const [status, setStatus] = useState('checking...');

  useEffect(() => {
    fetch(`${SIGNALING_SERVER_URL}/health`)
      .then((res) => res.json())
      .then((data) => setStatus(data.status))
      .catch(() => setStatus('unreachable'));
  }, []);

  const statusColor =
    status === 'healthy'
      ? 'text-link'
      : status === 'checking...'
        ? 'text-slate-400'
        : 'text-red-400';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          EasyShare
        </h1>
        <p className="text-slate-400 text-sm">
          Direct browser-to-browser file transfer. Scaffold is up and
          running — the real interface arrives in later stages.
        </p>
        <div className="rounded-lg border border-slate-800 bg-slate-900 px-4 py-3 font-mono text-sm">
          Signaling server:{' '}
          <span className={statusColor}>{status}</span>
        </div>
      </div>
    </div>
  );
}

export default App;
