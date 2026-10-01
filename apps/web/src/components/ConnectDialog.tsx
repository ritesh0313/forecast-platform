import { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api';
import type { Series } from '../types';
import { Icon } from './Icon';

export function ConnectDialog({
  onConnect,
  onClose,
}: {
  onConnect: (token: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="connect-dialog"
      onCancel={onClose}
      aria-labelledby="connect-title"
    >
      <button
        type="button"
        className="icon-button modal-close"
        aria-label="Close connection dialog"
        onClick={onClose}
      >
        <Icon name="close" />
      </button>
      <div className="modal-icon">
        <Icon name="lock" size={25} />
      </div>
      <h2 id="connect-title">Connect your workspace</h2>
      <p>
        Use a signed access token from your platform administrator. Your token stays in this browser
        tab’s memory and is cleared when you disconnect or reload.
      </p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            await apiClient(token.trim())<{ series: Series[] }>('/series');
            onConnect(token.trim());
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : 'Connection failed.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="access-token">Access token</label>
        <input
          id="access-token"
          autoFocus
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Paste your JWT access token"
          required
        />
        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}
        <button className="button primary full-width" disabled={busy || !token.trim()}>
          {busy ? 'Checking access…' : 'Connect workspace'}
          <Icon name="arrow" size={17} />
        </button>
      </form>
      <small>
        Reader access explores forecasts. Trainer access imports observations and starts model runs.
      </small>
    </dialog>
  );
}
