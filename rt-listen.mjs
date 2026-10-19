import { createClient } from '@supabase/supabase-js'
const c = createClient(process.env.VITE_SUPABASE_URL, process.env.VITE_SUPABASE_ANON_KEY)
const t = 'poll:d68df1be-51ac-460a-8915-e69b28e969c0'
c.channel(t, { config: { private: true } })
  .on('broadcast', { event: '*' }, m => console.log(new Date().toISOString(), 'HEARD', m.event))
  .subscribe((s, e) => console.log(new Date().toISOString(), s, e?.message ?? ''))
setTimeout(() => process.exit(0), 150000)
