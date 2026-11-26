import React from 'react';
import { t } from '../../../shared/i18n';
import { ErrorTip } from './ErrorTip';

interface Props {
  label?: string;
  children: React.ReactNode;
  onError?: () => void;
}

interface State {
  error: Error | null;
}

function reportCrash(label: string, error: Error, componentStack?: string): void {
  const payload = {
    label,
    message: error.message || String(error),
    stack: error.stack,
    componentStack: componentStack || undefined
  };
  const api = window.api?.app as
    | { reportRendererError?: (p: typeof payload) => Promise<unknown> }
    | undefined;
  void api?.reportRendererError?.(payload);
}

/** 防止单个面板（如 TerminalView）崩溃把整窗打白 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.();
    const label = this.props.label ?? 'panel';
    console.error(`[ErrorBoundary:${label}]`, error);
    reportCrash(label, error, info.componentStack ?? undefined);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div className="ui-empty">
          <ErrorTip message={t('{{label}}崩溃：', { label: this.props.label ?? t('面板') }) + this.state.error.message} />
          <button
            type="button"
            className="ui-btn"
            onClick={() => this.setState({ error: null })}
          >
            {t('重试')}
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
