export const QUEUE_SIZE = 8;

export class Queue {
  private order: string[] = [];

  join(steamid: string): void {
    if (!this.order.includes(steamid)) this.order.push(steamid);
  }

  leave(steamid: string): void {
    this.order = this.order.filter((id) => id !== steamid);
  }

  has(steamid: string): boolean {
    return this.order.includes(steamid);
  }

  count(): number {
    return this.order.length;
  }

  list(): string[] {
    return [...this.order];
  }

  takeBatch(n: number): string[] {
    return this.order.splice(0, n);
  }

  requeueFront(steamids: string[]): void {
    this.order = [...steamids.filter((id) => !this.order.includes(id)), ...this.order];
  }
}
