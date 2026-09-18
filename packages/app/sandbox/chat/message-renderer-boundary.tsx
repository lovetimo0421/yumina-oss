import React, { Component } from "react";

interface MessageRendererBoundaryProps {
  children?: React.ReactNode;
  fallback: React.ReactNode;
  /** Values which can make a previously failing renderer valid again. */
  resetKeys: readonly unknown[];
  onError?: (error: Error) => void;
}

interface MessageRendererBoundaryState {
  failed: boolean;
}

function resetKeysChanged(
  previous: readonly unknown[],
  current: readonly unknown[],
): boolean {
  if (previous.length !== current.length) return true;
  return previous.some((value, index) => !Object.is(value, current[index]));
}

/**
 * Creator-authored message renderers are intentionally flexible and can throw
 * at runtime for production-only content/state. Keep that failure scoped to the
 * affected bubble so the player can still read and continue the conversation.
 */
export class MessageRendererBoundary extends Component<
  MessageRendererBoundaryProps,
  MessageRendererBoundaryState
> {
  state: MessageRendererBoundaryState = { failed: false };

  static getDerivedStateFromError(): MessageRendererBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError?.(error);
  }

  componentDidUpdate(previousProps: MessageRendererBoundaryProps) {
    if (
      this.state.failed &&
      resetKeysChanged(previousProps.resetKeys, this.props.resetKeys)
    ) {
      this.setState({ failed: false });
    }
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
