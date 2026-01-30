const _env = (typeof env !== 'undefined' && env) || (window && window.ENV) || {};
const SUPABASE_URL = _env.SUPABASE_URL || _env.SUPABASE_URL || '';
const SUPABASE_KEY = _env.SUPABASE_KEY || _env.SUPABASE_ANON_KEY || '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
	console.error('Supabase credentials missing in client env. Set window.ENV or server-side injection.');
}
export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);