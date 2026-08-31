import { randomUUID } from 'node:crypto'

import { clone } from './graph-schema.js'
import { assertValidGraph } from './validator.js'
import { classifyExecutionError, normalizeNodeOutput } from './executors.js'

function messageOf(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 2000)
}

function nowValue(now) {
  return typeof now === 'function' ? Number(now()) : Date.now()
}

function sleep(ms, signal) {
  const delay = Math.max(0, Number(ms) || 0)
  if (!delay) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let timer = setTimeout(done, delay)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      const error = new Error('节点等待期间被取消。')
      error.code = 'ABORTED'
      error.category = 'cancelled'
      reject(error)
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

export class GraphScheduler {
  constructor(options = {}) {
    this.graph = clone(options.graph)
    this.validation = options.validation || assertValidGraph(this.graph)
    this.executor = options.executor
    this.storage = options.storage
    this.sessionId = String(options.sessionId || this.graph.sessionId || '')
    this.parentAgent = options.parentAgent
    this.cwd = options.cwd || process.cwd()
    this.now = options.now || (() => Date.now())
    this.idFactory = options.idFactory || (() => `run-${randomUUID()}`)
    this.onEvent = options.onEvent
    this.active = new Map()
    this.controllers = new Map()
    this.cancelRequested = false
    this.terminateRequested = false
    this.pauseEmitted = false
    this.disposed = false
    this.runPromise = null
    const now = nowValue(this.now)
    this.state = {
      schemaVersion: 1,
      runId: String(options.runId || this.idFactory('run')),
      graphId: this.graph.graphId,
      revision: this.graph.revision,
      sessionId: this.sessionId,
      status: 'created',
      goal: this.graph.goal,
      createdAt: now,
      startedAt: 0,
      endedAt: 0,
      updatedAt: now,
      error: '',
      nodeStates: Object.fromEntries(this.graph.nodes.map((node) => [node.id, {
        nodeId: node.id,
        status: 'pending',
        attempts: 0,
        startedAt: 0,
        endedAt: 0,
        error: '',
         errorCategory: '',
         childSessionId: '',
         result: null
      }]))
    }
  }

  snapshot() {
    return clone(this.state)
  }

  persist() {
    try { this.storage?.saveRun?.(this.state) } catch { /* a run remains observable in memory if disk persistence fails */ }
  }

  emit(type, data = {}, nodeId = '') {
    const event = {
      schemaVersion: 1,
      id: this.state.nextEventId || 1,
      runId: this.state.runId,
      graphId: this.state.graphId,
      revision: this.state.revision,
      type,
      nodeId: nodeId || undefined,
      at: nowValue(this.now),
      data: clone(data)
    }
    this.state.nextEventId = event.id + 1
    this.state.updatedAt = event.at
    try { this.storage?.appendRunEvent?.(this.state.graphId, this.state.runId, event) } catch { /* in-memory event callback still receives the event */ }
    try { this.onEvent?.(event, this.snapshot()) } catch { /* observers cannot stop the scheduler */ }
    this.persist()
    return event
  }

  start(options = {}) {
    if (options.confirmed !== true) throw new Error('Graph Job 必须先完成预览并获得用户确认后才能运行。')
    if (this.state.status !== 'created') throw new Error(`当前 run 状态不能启动：${this.state.status}`)
    this.state.status = 'running'
    this.state.startedAt = nowValue(this.now)
    this.emit('run/started', { confirmed: true })
    this.runPromise = this.loop()
    return this.snapshot()
  }

  async loop() {
    try {
      while (true) {
        if (this.cancelRequested || this.terminateRequested) {
          await this.drainActive()
          return this.finish(this.terminateRequested ? 'terminated' : 'cancelled')
        }
        if (this.state.status === 'paused') {
          await this.drainActive()
          this.markBlocked()
          if (!this.pauseEmitted) {
            this.pauseEmitted = true
            this.emit('run/paused', { error: this.state.error || '节点失败，等待用户 retry 或 terminate。' })
          }
          this.persist()
          return this.snapshot()
        }
        if (this.allSucceeded()) return this.finish('completed')
        this.markBlocked()
        const ready = this.readyNodes()
        this.launchReady(ready)
        if (this.active.size) {
          await Promise.race([...this.active.values()].map((item) => item.promise))
          continue
        }
        if (this.hasFailed()) {
          this.state.status = 'paused'
          continue
        }
        if (this.allSucceeded()) return this.finish('completed')
        this.state.status = 'paused'
        this.state.error = '调度器没有可运行节点，Graph 可能存在未满足的 barrier。'
      }
    } catch (error) {
      this.state.status = 'paused'
      this.state.error = messageOf(error)
      this.emit('run/paused', { error: this.state.error, code: error?.code || 'SCHEDULER_ERROR' })
      return this.snapshot()
    }
  }

  async drainActive() {
    if (!this.active.size) return
    for (const controller of this.controllers.values()) controller.abort()
    while (this.active.size) await Promise.race([...this.active.values()].map((item) => item.promise))
  }

  readyNodes() {
    return this.validation.topological.map((id) => this.graph.nodes.find((node) => node.id === id)).filter((node) => {
      const state = this.state.nodeStates[node.id]
      if (!state || state.status !== 'pending') return false
      const parents = this.validation.dependencies[node.id] || []
      return parents.every((parentId) => parentId === 'root' || this.state.nodeStates[parentId]?.status === 'succeeded')
    })
  }

  launchReady(nodes) {
    let totalSlots = Math.max(0, this.graph.limits.maxParallel - this.active.size)
    const writeActive = [...this.active.values()].some((item) => item.access === 'write')
    let writeTaken = writeActive
    for (const node of nodes) {
      if (totalSlots <= 0) break
      if (node.access === 'write') {
        if (writeTaken) continue
        writeTaken = true
      } else {
        if (totalSlots <= 0) continue
      }
      this.launchNode(node)
      totalSlots -= 1
    }
  }

  launchNode(node) {
    const state = this.state.nodeStates[node.id]
    state.status = 'ready'
    this.emit('node/ready', { access: node.access, kind: node.kind }, node.id)
    state.status = 'running'
    state.attempts += 1
    state.startedAt = nowValue(this.now)
    state.endedAt = 0
    state.error = ''
    state.errorCategory = ''
    const controller = new AbortController()
    this.controllers.set(node.id, controller)
    const predecessors = (this.validation.dependencies[node.id] || [])
      .filter((id) => id !== 'root')
      .map((id) => ({ nodeId: id, result: this.state.nodeStates[id]?.result }))
    this.emit('node/started', { attempt: state.attempts, access: node.access, kind: node.kind }, node.id)
    const promise = this.executeNode(node, state.attempts, predecessors, controller.signal)
      .then((result) => {
        state.status = 'succeeded'
        state.childSessionId = String(result?.childSessionId || '').trim()
        state.result = clone(result?.result || result)
        state.endedAt = nowValue(this.now)
        this.emit('node/succeeded', { attempt: state.attempts, artifactCount: state.result.artifactRefs.length, childSessionId: state.childSessionId || undefined }, node.id)
      })
      .catch((error) => this.handleNodeError(node, state, error))
      .finally(() => {
        this.controllers.delete(node.id)
        this.active.delete(node.id)
      })
    this.active.set(node.id, { promise, access: node.access })
  }

  async executeNode(node, attempt, predecessors, signal) {
    const profile = this.graph.agentProfiles.find((item) => item.id === node.agentProfileId)
    if (!profile && node.kind === 'task') throw new Error(`节点 ${node.id} 找不到 Agent Profile。`)
    if (node.kind === 'merge' && !node.agentProfileId) {
      const text = predecessors.map((item) => `[${item.nodeId}]\n${String(item.result?.text || '').trim()}`).filter(Boolean).join('\n\n')
      const artifactRefs = predecessors.flatMap((item) => Array.isArray(item.result?.artifactRefs) ? item.result.artifactRefs : [])
      return normalizeNodeOutput({ text, artifactRefs }, { cwd: this.cwd, contract: node.outputContract })
    }
    const request = {
      graph: this.graph,
      node,
      profile: profile || { id: 'merge', executor: 'dsh', provider: '', model: '', capabilities: { tools: [], skills: [] }, maxOutputTokens: 4096 },
      predecessorResults: predecessors,
      attempt,
      signal,
      parentAgent: this.parentAgent,
      sessionId: this.sessionId,
      cwd: this.cwd
    }
      const raw = typeof this.executor === 'function' ? await this.executor(request) : await this.executor?.runNode?.(request)
    const envelope = raw && typeof raw === 'object' && raw.result && typeof raw.result === 'object'
      ? raw
      : { result: raw, childSessionId: '' }
    return {
      result: normalizeNodeOutput(envelope.result, { cwd: this.cwd, contract: node.outputContract }),
      childSessionId: String(envelope.childSessionId || '').trim()
    }
  }

  async handleNodeError(node, state, error) {
    if (error?.childSessionId) state.childSessionId = String(error.childSessionId).trim()
    const classification = classifyExecutionError(error)
    if (this.cancelRequested || this.terminateRequested || classification.category === 'cancelled') {
      state.status = 'cancelled'
      state.error = messageOf(error)
      state.errorCategory = 'cancelled'
      state.endedAt = nowValue(this.now)
      this.emit('node/cancelled', { attempt: state.attempts }, node.id)
      return
    }
    if (classification.retryable && state.attempts <= this.graph.limits.maxRetries) {
      state.status = 'pending'
      state.error = messageOf(error)
      state.errorCategory = classification.category
      state.endedAt = nowValue(this.now)
      this.emit('node/retry', {
        attempt: state.attempts,
        nextAttempt: state.attempts + 1,
        category: classification.category,
        error: state.error
      }, node.id)
      try { await sleep(this.graph.limits.retryBackoffMs * Math.max(1, state.attempts), this.controllers.get(node.id)?.signal) } catch (retryError) {
        state.status = 'cancelled'
        state.errorCategory = 'cancelled'
        state.error = messageOf(retryError)
      }
      return
    }
    state.status = 'failed'
    state.error = messageOf(error)
    state.errorCategory = classification.category
    state.endedAt = nowValue(this.now)
    this.state.error = `节点 ${node.id} 失败：${state.error}`
    this.emit('node/failed', { attempt: state.attempts, category: classification.category, error: state.error }, node.id)
    this.state.status = 'paused'
    for (const [otherId, controller] of this.controllers.entries()) if (otherId !== node.id) controller.abort()
  }

  markBlocked() {
    for (const node of this.graph.nodes) {
      const state = this.state.nodeStates[node.id]
      if (!state || !['pending', 'ready'].includes(state.status)) continue
      const parents = this.validation.dependencies[node.id] || []
      if (parents.some((parentId) => parentId !== 'root' && ['failed', 'blocked', 'cancelled'].includes(this.state.nodeStates[parentId]?.status))) {
        state.status = 'blocked'
        state.endedAt = nowValue(this.now)
        this.emit('node/blocked', { reason: 'predecessor-failed' }, node.id)
      }
    }
  }

  hasFailed() {
    return Object.values(this.state.nodeStates).some((item) => item.status === 'failed')
  }

  allSucceeded() {
    const states = Object.values(this.state.nodeStates)
    return states.length > 0 && states.every((item) => item.status === 'succeeded')
  }

  finish(status, data = {}) {
    if (['completed', 'cancelled', 'terminated'].includes(this.state.status) && this.state.endedAt) return this.snapshot()
    this.state.status = status
    this.state.endedAt = nowValue(this.now)
    this.state.updatedAt = this.state.endedAt
    this.emit(`run/${status}`, { nodeCount: this.graph.nodes.length, ...data })
    return this.snapshot()
  }

  async retryFailed() {
    if (this.state.status !== 'paused') throw new Error(`只有 paused run 可以 retry：${this.state.status}`)
    const failed = Object.values(this.state.nodeStates).filter((item) => item.status === 'failed')
    if (!failed.length) throw new Error('当前 run 没有可 retry 的失败节点。')
    // A graph-wide pause aborts sibling nodes that were still running. Those
    // cancellations are part of the failed attempt and must be replayed with
    // the failed node; otherwise the barrier can never become runnable again.
    const reset = new Set(Object.values(this.state.nodeStates)
      .filter((item) => item.status === 'failed' || item.status === 'cancelled')
      .map((item) => item.nodeId))
    let changed = true
    while (changed) {
      changed = false
      for (const node of this.graph.nodes) {
        const parents = this.validation.dependencies[node.id] || []
        if (!reset.has(node.id) && parents.some((id) => reset.has(id))) { reset.add(node.id); changed = true }
      }
    }
    for (const id of reset) {
      const state = this.state.nodeStates[id]
      state.status = 'pending'
      state.error = ''
      state.errorCategory = ''
      state.childSessionId = ''
      state.result = null
      state.startedAt = 0
      state.endedAt = 0
    }
    this.state.error = ''
    this.state.status = 'running'
    this.pauseEmitted = false
    this.cancelRequested = false
    this.terminateRequested = false
    this.emit('run/retry', { failedNodeIds: failed.map((item) => item.nodeId), resetNodeIds: [...reset] })
    this.runPromise = this.loop()
    return this.snapshot()
  }

  async cancel() {
    if (['completed', 'cancelled', 'terminated'].includes(this.state.status)) return this.snapshot()
    this.cancelRequested = true
    this.state.error = '用户取消 Graph Job。'
    for (const state of Object.values(this.state.nodeStates)) if (['pending', 'ready', 'blocked'].includes(state.status)) state.status = 'cancelled'
    for (const controller of this.controllers.values()) controller.abort()
    if (!this.runPromise || this.state.status === 'paused') return this.finish('cancelled', { reason: 'user' })
    return this.runPromise
  }

  async terminate() {
    if (['completed', 'cancelled', 'terminated'].includes(this.state.status)) return this.snapshot()
    this.terminateRequested = true
    this.state.error = '用户终止 Graph Job。'
    for (const state of Object.values(this.state.nodeStates)) if (!['succeeded', 'failed'].includes(state.status)) state.status = 'cancelled'
    for (const controller of this.controllers.values()) controller.abort()
    if (!this.runPromise || this.state.status === 'paused') return this.finish('terminated', { reason: 'user' })
    return this.runPromise
  }

  async wait() {
    return this.runPromise ? this.runPromise : this.snapshot()
  }

  dispose() {
    this.disposed = true
    for (const controller of this.controllers.values()) controller.abort()
  }
}
