import { ReactNode } from 'react';
import { isDevMode } from '@/lib/auth';
import { Badge } from '@/components/ui/badge';
import { Construction } from 'lucide-react';

interface MobileLayoutProps {
  children: ReactNode;
}

const MobileLayout = ({ children }: MobileLayoutProps) => {
  const devMode = isDevMode();

  return (
    <div className="min-h-screen bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {devMode && (
        <div className="bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center justify-center gap-2">
          <Construction className="h-4 w-4 text-amber-600" />
          <span className="text-xs font-medium text-amber-700">Dev Mode — Auth Bypassed</span>
        </div>
      )}
      <div className="max-w-lg mx-auto min-h-screen">
        {children}
      </div>
    </div>
  );
};

export default MobileLayout;
