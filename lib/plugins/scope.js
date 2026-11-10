/**
 * 回收簿
 *
 * 与 Yunzai-NG 的 DisposalRegistry 同一套语义：
 * - 每一个登记项都返回一个幂等的 Disposer，调用即撤销并回收
 * - dispose() 按登记顺序**倒序**回收：后登记的依赖先登记的，所以先把使用者撤掉再撤被使用者
 * - 单个回收项抛错不会中断其余项，错误收集起来交给调用方打印
 * - 已经 dispose 之后再登记，会立刻执行这个 Disposer —— 防止异步初始化迟到注册造成泄漏
 * - addTimer 会顺带 unref()，让「只剩定时器」的进程能正常退出
 */
export class DisposalScope {
  /**
   * @param owner 归属名，通常是插件 key，只用于日志
   * @param onError (label, error) => void，登记项的回收出错时回调
   */
  constructor(owner = "anonymous", onError = null) {
    this.owner = owner
    this.onError = onError
    this.entries = []
    this.failures = []
    this.disposed = false
  }

  get size() {
    return this.entries.length
  }

  /**
   * 登记一个回收函数
   * @param fn 回收函数
   * @param label 日志标签
   * @returns 幂等 Disposer
   */
  add(fn, label = "anonymous") {
    const entry = { fn, label, done: false }
    const dispose = () => this.invoke(entry)
    if (this.disposed) {
      dispose()
      return dispose
    }
    this.entries.push(entry)
    return dispose
  }

  /** 登记一个定时器，并让它不阻止进程退出 */
  addTimer(timer, label = "timer") {
    timer?.unref?.()
    return this.add(() => clearInterval(timer), label)
  }

  /**
   * 把 Map / Set 里的一条也变成可回收项
   * @param collection Map 或 Set
   * @param key 要删除的键
   */
  addEntry(collection, key, label = "entry") {
    return this.add(() => collection.delete(key), label)
  }

  /**
   * 子簿：父簿回收时连带回收
   * 父簿已回收时，子簿会立即被回收（其中的登记项同样立即执行）
   */
  child(owner = this.owner) {
    const scope = new DisposalScope(owner, this.onError)
    this.add(() => {
      scope.dispose()
    }, `child:${owner}`)
    return scope
  }

  /** 单个登记项的回收，幂等且不外抛 */
  invoke(entry) {
    if (entry.done) return
    entry.done = true
    try {
      entry.fn()
    } catch (err) {
      this.failures.push({ label: entry.label, error: err })
      if (this.onError) {
        try {
          this.onError(entry.label, err)
        } catch (ignored) {}
      }
    }
  }

  /**
   * 倒序回收全部登记项
   * @returns [{ label, error }]，空数组表示干干净净
   */
  dispose() {
    if (this.disposed) return this.failures
    this.disposed = true
    for (let i = this.entries.length - 1; i >= 0; i--) {
      this.invoke(this.entries[i])
    }
    this.entries = []
    return this.failures
  }
}

/**
 * 把多个回收函数合并成一个
 * 与 NG 的 combineDisposers 一致：调用时逐个执行，互不影响
 */
export function combineDisposers(...disposers) {
  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch (ignored) {}
    }
  }
}

export default DisposalScope
