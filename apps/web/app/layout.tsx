import type { Metadata } from 'next';
import './style.css';
export const metadata: Metadata = { title: 'recruitment-platform', description: '架空データ専用の求人プラットフォーム' };
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ja"><body>{children}</body></html>;
}
