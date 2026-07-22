/*
 * Copyright 2026 Dira Africa
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export type DependencyName = 'gemini' | 'plantnet' | 'openmeteo' | 'hedera' | 'africastalking' | 'cloudflareR2';

export interface CircuitBreakerState {
  status: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failureCount: number;
  lastFailureTime: number | null;
}

export class DependencyRegistry {
  private states: Record<DependencyName, CircuitBreakerState> = {
    gemini: { status: 'CLOSED', failureCount: 0, lastFailureTime: null },
    plantnet: { status: 'CLOSED', failureCount: 0, lastFailureTime: null },
    openmeteo: { status: 'CLOSED', failureCount: 0, lastFailureTime: null },
    hedera: { status: 'CLOSED', failureCount: 0, lastFailureTime: null },
    africastalking: { status: 'CLOSED', failureCount: 0, lastFailureTime: null },
    cloudflareR2: { status: 'CLOSED', failureCount: 0, lastFailureTime: null },
  };

  private threshold = 3;
  private cooldownMs = 10000; // 10 seconds cooldown

  /**
   * Checks if a dependency is available to query.
   * If the circuit is open but the cooldown time has elapsed,
   * it enters a HALF_OPEN state and allows the probe request.
   */
  public isAvailable(name: DependencyName): boolean {
    const state = this.states[name];
    if (state.status === 'OPEN') {
      const now = Date.now();
      if (state.lastFailureTime && now - state.lastFailureTime > this.cooldownMs) {
        state.status = 'HALF_OPEN';
        console.log(`[CircuitBreaker] ${name} transitioned to HALF_OPEN`);
        return true;
      }
      return false;
    }
    return true;
  }

  /**
   * Records a successful execution of the dependency, resetting failure tracking.
   */
  public recordSuccess(name: DependencyName) {
    const state = this.states[name];
    state.failureCount = 0;
    state.lastFailureTime = null;
    if (state.status !== 'CLOSED') {
      state.status = 'CLOSED';
      console.log(`[CircuitBreaker] ${name} transitioned to CLOSED (Healthy)`);
    }
  }

  /**
   * Records a failed execution of the dependency, tripping the circuit if threshold met.
   */
  public recordFailure(name: DependencyName, error?: any) {
    const state = this.states[name];
    state.failureCount++;
    state.lastFailureTime = Date.now();
    console.warn(`[CircuitBreaker] Recorded failure for ${name} (${state.failureCount}/${this.threshold}). Error: ${error?.message || error}`);
    if (state.failureCount >= this.threshold) {
      state.status = 'OPEN';
      console.error(`[CircuitBreaker] ${name} tripped to OPEN (Offline)`);
    }
  }

  /**
   * Returns health status of all tracked dependencies.
   */
  public getStatusReport() {
    return Object.entries(this.states).map(([name, state]) => ({
      name,
      status: state.status,
      failureCount: state.failureCount,
      lastFailureTime: state.lastFailureTime ? new Date(state.lastFailureTime).toISOString() : null,
      healthy: state.status !== 'OPEN',
    }));
  }

  /**
   * Allows tests to manually override/reset circuit breaker states.
   */
  public setCircuitState(name: DependencyName, status: 'CLOSED' | 'OPEN' | 'HALF_OPEN') {
    const state = this.states[name];
    state.status = status;
    if (status === 'OPEN') {
      state.failureCount = this.threshold;
      state.lastFailureTime = Date.now();
    } else if (status === 'CLOSED') {
      state.failureCount = 0;
      state.lastFailureTime = null;
    }
  }
}

export const dependencyRegistry = new DependencyRegistry();
