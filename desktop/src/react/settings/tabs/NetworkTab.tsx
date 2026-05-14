import React, { useState, useCallback, useEffect } from 'react';
import { useSettingsStore } from '../store';
import { t } from '../helpers';
import { hanaFetch } from '../api';
import { Toggle } from '../widgets/Toggle';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsRow } from '../components/SettingsRow';
import styles from '../Settings.module.css';

interface ProxyConfig {
  enabled: boolean;
  url: string;
  username: string;
  password: string;
  no_proxy: string;
}

const DEFAULT_PROXY: ProxyConfig = {
  enabled: false,
  url: '',
  username: '',
  password: '',
  no_proxy: '',
};

export function NetworkTab() {
  const showToast = useSettingsStore(s => s.showToast);
  const [proxy, setProxy] = useState<ProxyConfig>(DEFAULT_PROXY);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    hanaFetch('/api/proxy')
      .then(res => res.json())
      .then(data => {
        if (data.proxy) setProxy(data.proxy);
      })
      .catch(() => {});
  }, []);

  const saveProxy = useCallback(async (patch: Partial<ProxyConfig>) => {
    const next = { ...proxy, ...patch };
    setProxy(next);
    try {
      const res = await hanaFetch('/api/proxy', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(next),
      });
      const data = await res.json();
      if (data.ok) {
        showToast(t('settings.autoSaved'), 'success');
        if (data.proxy) setProxy(data.proxy);
      } else {
        showToast(data.error || t('settings.saveFailed'), 'error');
      }
    } catch (err: any) {
      showToast(t('settings.saveFailed') + ': ' + err.message, 'error');
    }
  }, [proxy, showToast]);

  const handleTest = useCallback(async () => {
    if (!proxy.url) {
      showToast(t('settings.network.proxyUrlRequired'), 'error');
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await hanaFetch('/api/proxy/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: proxy.url, username: proxy.username, password: proxy.password }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({ ok: true, message: t('settings.network.testSuccess', { ip: data.ip }) });
      } else {
        setTestResult({ ok: false, message: data.error || t('settings.network.testFailed') });
      }
    } catch (err: any) {
      setTestResult({ ok: false, message: err.message });
    } finally {
      setTesting(false);
    }
  }, [proxy, showToast]);

  return (
    <div className={`${styles['settings-tab-content']} ${styles['active']}`} data-tab="network">
      <SettingsSection title={t('settings.network.proxy')}>
        <SettingsRow
          label={t('settings.network.enableProxy')}
          hint={t('settings.network.enableProxyHint')}
          control={<Toggle on={proxy.enabled} onChange={(on) => saveProxy({ enabled: on })} />}
        />

        {proxy.enabled && (
          <SettingsSection.SubBlock title={t('settings.network.proxy')}>
            <div className={styles['network-form']}>
              <label className={styles['settings-form-field']}>
                <span className={styles['settings-form-label']}>{t('settings.network.proxyUrl')}</span>
                <input
                  className={styles['settings-input']}
                  type="text"
                  value={proxy.url}
                  placeholder="http://127.0.0.1:7890"
                  onChange={(e) => setProxy({ ...proxy, url: e.target.value })}
                  onBlur={() => saveProxy({ url: proxy.url })}
                />
                <span className={styles['settings-form-hint']}>{t('settings.network.proxyUrlHint')}</span>
              </label>

              <div className={styles['network-form-grid']}>
                <label className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
                  <span className={styles['settings-form-label']}>{t('settings.network.proxyUsername')}</span>
                  <input
                    className={styles['settings-input']}
                    type="text"
                    value={proxy.username}
                    placeholder={t('settings.network.optional')}
                    onChange={(e) => setProxy({ ...proxy, username: e.target.value })}
                    onBlur={() => saveProxy({ username: proxy.username })}
                  />
                </label>
                <label className={`${styles['settings-form-field']} ${styles['settings-form-field-half']}`}>
                  <span className={styles['settings-form-label']}>{t('settings.network.proxyPassword')}</span>
                  <input
                    className={styles['settings-input']}
                    type="password"
                    value={proxy.password}
                    placeholder={t('settings.network.optional')}
                    onChange={(e) => setProxy({ ...proxy, password: e.target.value })}
                    onBlur={() => saveProxy({ password: proxy.password })}
                  />
                </label>
              </div>

              <label className={styles['settings-form-field']}>
                <span className={styles['settings-form-label']}>{t('settings.network.noProxy')}</span>
                <input
                  className={styles['settings-input']}
                  type="text"
                  value={proxy.no_proxy}
                  placeholder="localhost,127.0.0.1"
                  onChange={(e) => setProxy({ ...proxy, no_proxy: e.target.value })}
                  onBlur={() => saveProxy({ no_proxy: proxy.no_proxy })}
                />
                <span className={styles['settings-form-hint']}>{t('settings.network.noProxyHint')}</span>
              </label>

              <div className={styles['network-actions']}>
                <div>
                  {testResult &&
                    <span className={testResult?.ok ? styles['network-test-ok'] : styles['network-test-fail']}>
                      {testResult.message}
                    </span>
                  }
                </div>
                <button
                  className={styles['settings-btn-primary']}
                  onClick={handleTest}
                  disabled={testing}
                >
                  {testing ? t('settings.network.testing') : t('settings.network.testBtn')}
                </button>
              </div>
            </div>
          </SettingsSection.SubBlock>
        )}
      </SettingsSection>
    </div>
  );
}
