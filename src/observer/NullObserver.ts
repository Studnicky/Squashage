import type { ProvObserverInterface } from './ProvObserverInterface.js';

/** No-op observer for tests and dispatcher-construction smoke paths. */
export class NullObserver implements ProvObserverInterface {
  recordFlowStart(_dagName: string): void { /* no-op */ }
  recordFlowEnd(_dagName: string, _lifecycleKind: string): void { /* no-op */ }
  recordNodeStart(_nodeName: string): void { /* no-op */ }
  recordNodeEnd(_nodeName: string, _output: string | null): void { /* no-op */ }
  recordError(_nodeName: string, _error: Error): void { /* no-op */ }
}
