import { ErrorTip } from '../ErrorTip';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WebAccessStatusInfo } from '../../../../shared/webAccess';
import { isWebGateway } from '../../webGatewayEnvironment';
import { AdvancedDetails, FieldRow, SettingRow, SettingsRows, SettingsSection } from './shared';
import { ChannelRemoteInput } from './ChannelRemoteInput';

/** 网址连接小节：当前网关地址 + 二维码 + 复制 / 重新生成 token（全部即时生效） */
function UrlAccessSection(): React.JSX.Element {
  const { t } = useTranslation();
  const [web, setWeb] = useState<WebAccessStatusInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void window.api.webAccess.status().then(setWeb);
  }, []);

  const copy = (url: string): void => {
    void navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopiedUrl(url);
        window.setTimeout(() => setCopiedUrl((cur) => (cur === url ? '' : cur)), 1500);
      })
      .catch(() => setMsg(t('复制失败：请手动选择网址复制')));
  };

  const rotate = async (): Promise<void> => {
    try {
      setBusy(true);
      setMsg('');
      const res = await window.api.webAccess.rotate();
      if (res.ok && res.status) setWeb(res.status);
      else setMsg(res.error ?? t('操作失败'));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const urlRow = (url: string, tag?: string): React.JSX.Element => (
    <div className="webaccess-url-row" key={url}>
      <code title={url}>{url}</code>
      {tag ? <span className="webaccess-url-tag">{tag}</span> : null}
      <button type="button" className="btn tiny" onClick={() => copy(url)}>
        {copiedUrl === url ? t('已复制') : t('复制')}
      </button>
    </div>
  );

  if (!web) return <p className="empty-hint">{t('加载网页访问状态…')}</p>;

  const primary = web.urls.find((u) => !u.includes('127.0.0.1')) ?? web.urls[0] ?? '';
  const others = web.urls.filter((u) => u !== primary);

  return (
    <>
      <SettingsSection
        title={t('用网址打开')}
        item="webaccess-url"
        side={
          <>
            {web.running ? (
              <span className="s-tag ok">{t('服务运行中')}</span>
            ) : (
              <span className="s-tag">{t('未启动')}</span>
            )}
          </>
        }
      >
        {!web.running ? (
          <p className="s-sec-desc" style={{ margin: '0 0 4px' }}>
            {web.disabledReason || t('网页访问未启动（可用环境变量 MUSTER_WEB=0 关闭，或启动失败）')}
          </p>
        ) : (
          <>
            <div className="webaccess-hero">
              {web.qrDataUrl ? (
                <img className="webaccess-qr" src={web.qrDataUrl} alt={t('网页访问二维码')} />
              ) : (
                <p className="empty-hint">{t('二维码生成中…')}</p>
              )}
              <div className="webaccess-hero-body">
                <div className="webaccess-hero-title">{t('手机扫码，或复制网址到浏览器')}</div>
                {primary ? urlRow(primary) : null}
                <ol className="webaccess-steps">
                  <li>{t('手机和电脑在同一个网络（跨网可用 Tailscale / ZeroTier 等组网工具）')}</li>
                  <li>{t('这个网址等于工作台的全部权限，别发给别人')}</li>
                  <li>{t('重启后网址不变，可以收藏成书签')}</li>
                </ol>
              </div>
            </div>
            {others.length ? (
              <AdvancedDetails summary={t('其他网址（{{n}} 个）', { n: others.length })}>
                <div className="webaccess-urls">
                  {others.map((url) => urlRow(url, url.includes('127.0.0.1') ? t('本机') : undefined))}
                </div>
              </AdvancedDetails>
            ) : null}
          </>
        )}
        <ErrorTip message={msg} />
      </SettingsSection>

      {web.running ? (
        <SettingsSection title={t('安全')}>
          <SettingsRows>
            <SettingRow
              title={t('重置访问密钥')}
              desc={t('怀疑网址泄露时用。旧网址立即失效，已连接的设备会被断开')}
            >
              <button type="button" className="btn danger tiny" disabled={busy} onClick={() => void rotate()}>
                {t('重新生成 Token')}
              </button>
            </SettingRow>
          </SettingsRows>
        </SettingsSection>
      ) : null}
    </>
  );
}


/** Webhook 触发小节（T3.2）：hook 地址 + 签名密钥 + 公网风险提示 */
export function HookAccessSection(): React.JSX.Element {
  const { t } = useTranslation();
  const [web, setWeb] = useState<WebAccessStatusInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const [msg, setMsg] = useState('');

  useEffect(() => {
    void window.api.webAccess.status().then(setWeb);
  }, []);

  const hook = web?.hook ?? null;

  const copy = (text: string): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(text);
        window.setTimeout(() => setCopied((cur) => (cur === text ? '' : cur)), 1500);
      })
      .catch(() => setMsg(t('复制失败：请手动选择网址复制')));
  };

  const apply = async (
    fn: () => Promise<{ ok: boolean; status?: WebAccessStatusInfo; error?: string }>
  ): Promise<void> => {
    try {
      setBusy(true);
      setMsg('');
      const res = await fn();
      if (res.ok && res.status) setWeb(res.status);
      else setMsg(res.error ?? t('操作失败'));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const randomSecret = (): string => {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  };

  return (
    <div className="webaccess-hook" data-settings-item="webaccess-hook">
      <p className="settings-hint">
        {t('将地址填入 GitHub 或 GitLab 的 Webhook，内容类型选 application/json；通过事件订阅接收对应事件。')}
      </p>
      {!hook?.path ? (
        <p className="empty-hint">{t('网页访问未启动，hook 端点不可用')}</p>
      ) : (
        <>
          <FieldRow label={t('Webhook 地址')}><div className="webaccess-urls">
            {hook.urls.map((url, i) => (
              <div className="webaccess-url-row" key={url}>
                <code>{url}</code>
                <button type="button" className="btn tiny" onClick={() => copy(url)}>
                  {copied === url ? t('已复制') : t('复制')}
                </button>
                {url.includes('127.0.0.1') ? null : i === 0 ? (
                  <span className="webaccess-url-tag">{t('推荐')}</span>
                ) : null}
              </div>
            ))}
          </div></FieldRow>
          <FieldRow label={t('Webhook 密钥（GitHub Secret / GitLab Secret token）')}>
          <div className="hook-secret-value">
            {hook.signatureEnabled ? (
              <>
                <code>{hook.secret}</code>{' '}
                <button type="button" className="btn tiny" onClick={() => copy(hook.secret)}>
                  {copied === hook.secret ? t('已复制') : t('复制')}
                </button>{' '}
              </>
            ) : (
              <span>{t('未配置（GitLab 必须先配置密钥）')}</span>
            )}
          </div>
          <div className="hook-actions">
            <button
              type="button"
              className="btn tiny"
              disabled={busy}
              onClick={() => void apply(() => window.api.webAccess.setHookSecret(randomSecret()))}
            >
              {hook.signatureEnabled ? t('换一个密钥') : t('生成密钥')}
            </button>{' '}
            {hook.signatureEnabled && (
              <button
                type="button"
                className="btn tiny"
                disabled={busy}
                onClick={() => void apply(() => window.api.webAccess.setHookSecret(''))}
              >
                {t('清除密钥')}
              </button>
            )}
          </div>
          <p className="settings-hint">
            {hook.signatureEnabled
              ? t('GitHub 校验签名，GitLab 校验 Secret token；校验失败会拒绝请求。')
              : t('GitHub 未启用签名校验；GitLab 需要先生成密钥并填入 Secret token。')}
          </p>
          </FieldRow>
          <SettingRow title={t('重置 Webhook 地址')} desc={t('旧 hook 地址立即失效（不影响网页访问）')}>
            <button
              type="button"
              className="btn danger tiny"
              disabled={busy}
              onClick={() => void apply(() => window.api.webAccess.rotateHook())}
            >
              {t('重新生成 Hook 地址')}
            </button>
          </SettingRow>
        </>
      )}
      <div className="settings-hint">
        {t('风险提示：hook 地址即凭证。若把端口暴露到公网，任何人拿到该地址都能触发任务（任务提示词拥有本机权限）。请保持在内网 / Tailscale 内使用，并配置签名密钥。')}
      </div>
      <ErrorTip message={msg} />
    </div>
  );
}

/** 设置「远程访问」页：全局 Channel 远程输入、网址连接与 Webhook。 */
export function RemoteAccessSettings({ active = true, onOpenChannels }: {
  active?: boolean; onOpenChannels?: () => void;
} = {}): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="settings-section">
      {!isWebGateway() && <ChannelRemoteInput active={active} onOpenChannels={onOpenChannels} />}
      <UrlAccessSection />
      <SettingsSection title={t('Webhook')} desc={t('允许 GitHub、GitLab 等服务通过 Webhook 触发任务。')}>
        <HookAccessSection />
      </SettingsSection>
    </div>
  );
}
