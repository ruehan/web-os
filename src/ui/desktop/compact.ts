// 좁은 화면(휴대폰)에서는 창을 겹쳐 놓을 자리가 없으므로, 창 하나가 화면 전체를 쓰는 방식으로 바꾼다.
import { createSignal } from 'solid-js'

const query = matchMedia('(max-width: 640px)')
const [compact, setCompact] = createSignal(query.matches)
query.addEventListener('change', (e) => setCompact(e.matches))

export { compact }
