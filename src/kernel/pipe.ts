/** 조건이 충족될 때까지 시스템 콜을 미뤄 둔 프로세스들. */
export class WaitQueue {
  pids = new Set<number>()
}

/** 한쪽에서 쓰고 다른 쪽에서 읽는 단방향 바이트 통로. 용량이 차면 쓰는 쪽이 멈춘다. */
export class Pipe {
  static CAPACITY = 64 * 1024

  private chunks: Uint8Array[] = []
  size = 0
  /** 열려 있는 읽기·쓰기 끝의 수. 0이 되면 반대쪽이 EOF 또는 끊김을 본다. */
  readers = 1
  writers = 1
  readQ = new WaitQueue()
  writeQ = new WaitQueue()

  /** 받아들인 바이트 수를 돌려준다. 가득 찼으면 0이다. */
  write(data: Uint8Array): number {
    const n = Math.min(data.length, Pipe.CAPACITY - this.size)
    if (n > 0) {
      this.chunks.push(data.slice(0, n))
      this.size += n
    }
    return n
  }

  read(max: number): Uint8Array {
    const out = new Uint8Array(Math.min(max, this.size))
    let filled = 0
    while (filled < out.length) {
      const head = this.chunks[0]!
      const take = Math.min(head.length, out.length - filled)
      out.set(head.subarray(0, take), filled)
      filled += take
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
    }
    this.size -= filled
    return out
  }
}
