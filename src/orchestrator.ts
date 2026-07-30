/** Sub-project 2 replaces DevOrchestrator with the real RCON-driven implementation. */
export interface Orchestrator {
  setupMatch(matchId: number): Promise<void>;
}

export class DevOrchestrator implements Orchestrator {
  async setupMatch(matchId: number): Promise<void> {
    console.log(`[orchestrator-stub] match ${matchId} created; server setup arrives in sub-project 2`);
  }
}
