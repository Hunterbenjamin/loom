/** Resources and pending work belong to one webContents; panel IDs are local to that owner. */
export class OwnedResources<T> {
  private owners = new Map<number, Map<string, T>>();
  private pending = new Map<number, Map<string, symbol>>();
  constructor(private dispose: (value: T) => void) {}
  open(owner: number) {
    this.owners.set(owner, new Map());
    this.pending.set(owner, new Map());
  }
  begin(owner: number, id: string): symbol {
    const requests = this.pending.get(owner);
    if (!requests) throw new Error("Unknown window");
    this.kill(owner, id);
    const token = Symbol(id);
    requests.set(id, token);
    return token;
  }
  finish(owner: number, id: string, token: symbol, value: T): boolean {
    if (this.pending.get(owner)?.get(id) !== token) {
      this.dispose(value);
      return false;
    }
    this.pending.get(owner)?.delete(id);
    this.owners.get(owner)?.set(id, value);
    return true;
  }
  get(owner: number, id: string) {
    return this.owners.get(owner)?.get(id);
  }
  delete(owner: number, id: string, value: T) {
    if (this.get(owner, id) !== value) return false;
    this.owners.get(owner)?.delete(id);
    return true;
  }
  kill(owner: number, id: string) {
    this.pending.get(owner)?.delete(id);
    const value = this.get(owner, id);
    this.owners.get(owner)?.delete(id);
    if (value) this.dispose(value);
    return !!value;
  }
  close(owner: number) {
    this.pending.delete(owner);
    const values = this.owners.get(owner);
    this.owners.delete(owner);
    for (const value of values?.values() ?? []) this.dispose(value);
  }
}
