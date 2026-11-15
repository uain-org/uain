import type { Metadata } from 'next';
export const metadata: Metadata = { title: 'Administration — United AI Network', robots: { index:false,follow:false } };
export default function AdminEntry() {
  return <main className="page-shell" style={{paddingTop:80,paddingBottom:100,maxWidth:900}}>
    <p>United AI Network</p><h1>UAIN administration</h1>
    <p>Authorized operators use a separate administration portal with its own organization sign-in. It is not linked from the public site.</p>
    <a href="/">Return to UAIN</a>
  </main>;
}
