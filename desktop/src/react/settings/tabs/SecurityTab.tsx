import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { useSettingsStore } from '../store';
import { autoSaveConfig, t } from '../helpers';
import { hanaFetch } from '../api';
import { loadSettingsConfig } from '../actions';
import { Toggle } from '../widgets/Toggle';
import { SelectWidget } from '@/ui';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import { ExpandableRow } from '../components/ExpandableRow';
import styles from '../Settings.module.css';

interface Checkpoint {
  id: string;
  ts: number;
  tool: string;
  path: string;
  size: number;
}

const RETENTION_OPTIONS = [
  { value: 1, key: 'settings.security.retention1d' },
  { value: 3, key: 'settings.security.retention3d' },
  { value: 7, key: 'settings.security.retention7d' },
];

const SIZE_OPTIONS = [
  { value: 512, label: '512 KB' },
  { value: 1024, label: '1 MB' },
  { value: 5120, label: '5 MB' },
  { value: 10240, label: '10 MB' },
];

export function SecurityTab() {
  const settingsConfig = useSettingsStore(s => s.settingsConfig);
  const showToast = useSettingsStore(s => s.showToast);
  const sandboxEnabled = settingsConfig?.sandbox !== false;
  const sandboxNetworkEnabled = settingsConfig?.sandbox_network === true;
  const sandboxWritablePaths = useMemo((): string[] => {
    const p = settingsConfig?.sandbox_writable_paths;
    return Array.isArray(p) ? p : [];
  }, [settingsConfig?.sandbox_writable_paths]);
  const fileBackup = settingsConfig?.file_backup || { enabled: false, retention_days: 1, max_file_size_kb: 1024 };

  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [newWritablePath, setNewWritablePath] = useState('');
  const [defaultPaths, setDefaultPaths] = useState<string[]>([]);

  useEffect(() => {
    if (!sandboxEnabled) return;
    hanaFetch('/api/config/sandbox-default-paths')
      .then(r => r.json())
      .then(d => setDefaultPaths(d.paths || []))
      .catch(() => setDefaultPaths([]));
  }, [sandboxEnabled]);

  const handleSandboxToggle = useCallback(async (on: boolean) => {
    await autoSaveConfig({ sandbox: on }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleSandboxNetworkToggle = useCallback(async (on: boolean) => {
    await autoSaveConfig({ sandbox_network: on }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const addWritablePath = useCallback(async () => {
    const p = newWritablePath.trim();
    if (!p || sandboxWritablePaths.includes(p)) return;
    await autoSaveConfig({ sandbox_writable_paths: [...sandboxWritablePaths, p] }, { silent: true });
    setNewWritablePath('');
    await loadSettingsConfig();
  }, [newWritablePath, sandboxWritablePaths]);

  const removeWritablePath = useCallback(async (p: string) => {
    await autoSaveConfig({ sandbox_writable_paths: sandboxWritablePaths.filter(x => x !== p) }, { silent: true });
    await loadSettingsConfig();
  }, [sandboxWritablePaths]);

  const handleBackupToggle = useCallback(async (on: boolean) => {
    const current = useSettingsStore.getState().settingsConfig?.file_backup || {};
    await autoSaveConfig({ file_backup: { ...current, enabled: on } }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleRetentionChange = useCallback(async (value: string) => {
    const days = parseInt(value, 10);
    const current = useSettingsStore.getState().settingsConfig?.file_backup || {};
    await autoSaveConfig({ file_backup: { ...current, retention_days: days } }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const handleMaxSizeChange = useCallback(async (value: string) => {
    const kb = parseInt(value, 10);
    const current = useSettingsStore.getState().settingsConfig?.file_backup || {};
    await autoSaveConfig({ file_backup: { ...current, max_file_size_kb: kb } }, { silent: true });
    await loadSettingsConfig();
  }, []);

  const loadCheckpoints = useCallback(async () => {
    setLoading(true);
    try {
      const res = await hanaFetch('/api/checkpoints');
      const data = await res.json();
      setCheckpoints(data.checkpoints || []);
    } catch {
      setCheckpoints([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleRestore = useCallback(async (id: string) => {
    try {
      const res = await hanaFetch(`/api/checkpoints/${id}/restore`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        showToast(t('settings.security.restoreSuccess'), 'success');
      } else {
        showToast(t('settings.security.restoreFailed'), 'error');
      }
    } catch {
      showToast(t('settings.security.restoreFailed'), 'error');
    }
  }, [showToast]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleString();
  };

  const formatPath = (p: string) => {
    const parts = p.split('/').filter(Boolean);
    if (parts.length <= 2) return p;
    return '.../' + parts.slice(-2).join('/');
  };

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="security">
      <SettingsSection title={t('settings.security.sandbox')}>
        <SettingsRow
          label={t('settings.security.sandbox')}
          hint={t('settings.security.sandboxDesc')}
          control={<Toggle on={sandboxEnabled} onChange={handleSandboxToggle} />}
        />
        <SettingsRow
          label={t('settings.security.sandboxNetwork')}
          hint={sandboxEnabled
            ? t('settings.security.sandboxNetworkDesc')
            : t('settings.security.sandboxNetworkDisabledDesc')}
          control={
            <Toggle
              on={sandboxNetworkEnabled}
              onChange={handleSandboxNetworkToggle}
              disabled={!sandboxEnabled}
            />
          }
        />

        {sandboxEnabled && (
          <div className={styles['sandbox-paths-wrapper']}>
            <div className={styles['sandbox-paths-header']}>
              <span className={styles['sandbox-paths-title']}>{t('settings.security.sandboxWritablePaths')}</span>
            </div>
            <div className={styles['sandbox-paths-list']}>
              {defaultPaths.map(p => (
                <div key={p} className={styles['sandbox-path-row']}>
                  <span className={`${styles['sandbox-path-text']} ${styles['sandbox-path-locked']}`}>{p}</span>
                  <span className={styles['sandbox-path-badge']}>...</span>
                </div>
              ))}
              {sandboxWritablePaths.map(p => (
                <div key={p} className={styles['sandbox-path-row']}>
                  <span className={styles['sandbox-path-text']}>{p}</span>
                  <button
                    className={styles['sandbox-path-remove']}
                    onClick={() => removeWritablePath(p)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <div className={styles['sandbox-add-row']}>
              <input
                className={styles['sandbox-add-input']}
                type="text"
                placeholder={t('settings.security.sandboxPathPlaceholder')}
                value={newWritablePath}
                onChange={(e) => setNewWritablePath(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addWritablePath();
                }}
              />
              <button
                className={styles['sandbox-add-btn']}
                onClick={addWritablePath}
              >
                {t('settings.security.sandboxAddPath')}
              </button>
            </div>
          </div>
        )}

        {!sandboxEnabled && (
          <SettingsSection.Warning>
            {t('settings.security.sandboxWarning')}
          </SettingsSection.Warning>
        )}
      </SettingsSection>

      <SettingsSection title={t('settings.security.fileBackup')}>
        <SettingsRow
          label={t('settings.security.fileBackup')}
          hint={t('settings.security.fileBackupDesc')}
          control={<Toggle on={fileBackup.enabled} onChange={handleBackupToggle} />}
        />

        {fileBackup.enabled && (
          <>
            <SettingsRow
              label={t('settings.security.retention')}
              control={
                <SelectWidget
                  value={String(fileBackup.retention_days)}
                  onChange={handleRetentionChange}
                  options={RETENTION_OPTIONS.map(opt => ({ value: String(opt.value), label: t(opt.key) }))}
                />
              }
            />

            <SettingsRow
              label={t('settings.security.maxFileSize')}
              control={
                <SelectWidget
                  value={String(fileBackup.max_file_size_kb)}
                  onChange={handleMaxSizeChange}
                  options={SIZE_OPTIONS.map(opt => ({ value: String(opt.value), label: opt.label }))}
                />
              }
            />

            <ExpandableRow
              label={t('settings.security.viewBackups')}
              count={checkpoints.length || undefined}
              onToggle={(expanded) => {
                if (expanded) loadCheckpoints();
              }}
            >
              {loading ? (
                <span className={styles['capability-row-desc']}>...</span>
              ) : checkpoints.length === 0 ? (
                <span className={styles['capability-row-desc']}>{t('settings.security.noBackups')}</span>
              ) : (
                checkpoints.map(cp => (
                  <div key={cp.id} className={styles['settings-backup-item']}>
                    <span className={styles['settings-backup-time']}>{formatTime(cp.ts)}</span>
                    <span className={styles['settings-backup-path']}>{formatPath(cp.path)}</span>
                    <button
                      className={styles['settings-backup-restore-btn']}
                      onClick={() => handleRestore(cp.id)}
                    >
                      {t('settings.security.restoreBtn')}
                    </button>
                  </div>
                ))
              )}
            </ExpandableRow>
          </>
        )}
      </SettingsSection>
    </div>
  );
}
