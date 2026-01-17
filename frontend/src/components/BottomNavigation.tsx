import { useNavigate, useLocation } from 'react-router-dom';
import { Home, Upload, FileText, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavItem {
  path: string;
  icon: typeof Home;
  label: string;
}

const navItems: NavItem[] = [
  { path: '/', icon: Home, label: 'Home' },
  { path: '/upload', icon: Upload, label: 'Upload' },
  { path: '/receipts', icon: FileText, label: 'Receipts' },
  { path: '/settings', icon: Settings, label: 'Settings' },
];

const BottomNavigation = () => {
  const navigate = useNavigate();
  const location = useLocation();

  // Don't show on certain pages
  const hiddenPaths = ['/auth/callback', '/processing', '/review'];
  const shouldHide = hiddenPaths.some((path) => location.pathname.startsWith(path));
  
  if (shouldHide) return null;

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border z-40">
      <div className="max-w-lg mx-auto flex items-center justify-around h-16">
        {navItems.map((item) => {
          const isActive = location.pathname === item.path;
          const Icon = item.icon;
          
          return (
            <button
              key={item.path}
              onClick={() => navigate(item.path)}
              className={cn(
                'flex flex-col items-center justify-center w-16 h-full gap-1 transition-colors',
                isActive 
                  ? 'text-primary' 
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-5 w-5" />
              <span className="text-xs font-medium">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export default BottomNavigation;