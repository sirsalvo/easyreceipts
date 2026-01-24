import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Upload, FileText, Receipt } from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import BottomNavigation from '@/components/BottomNavigation';
import { A2HSBanner } from '@/components/A2HSBanner';
import appIcon from '@/assets/app-icon.png';

const Index = () => {
  const navigate = useNavigate();

  return (
    <MobileLayout>
      <div className="p-4 space-y-6 pb-24">
        {/* Header */}
        <div className="flex items-center gap-3 pt-4">
          <img 
            src={appIcon} 
            alt="Spendify" 
            className="w-12 h-12 rounded-xl"
          />
          <div>
            <h1 className="text-xl font-bold">Spendify</h1>
            <p className="text-sm text-muted-foreground">Scan & Manage</p>
          </div>
        </div>

        <A2HSBanner />

        {/* Main Actions */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Quick Actions</h2>
          
          <Card
            className="cursor-pointer hover:shadow-md transition-shadow active:scale-[0.99]"
            onClick={() => navigate('/upload')}
          >
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center">
                  <Upload className="h-7 w-7 text-primary" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold">Upload Receipt</h3>
                  <p className="text-sm text-muted-foreground">
                    Take a photo or select from gallery
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-md transition-shadow active:scale-[0.99]"
            onClick={() => navigate('/receipts')}
          >
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-secondary/10 flex items-center justify-center">
                  <FileText className="h-7 w-7 text-secondary" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold">Your Receipts</h3>
                  <p className="text-sm text-muted-foreground">
                    View and manage your receipts
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card
            className="cursor-pointer hover:shadow-md transition-shadow active:scale-[0.99]"
            onClick={() => navigate('/export')}
          >
            <CardContent className="p-6">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-accent flex items-center justify-center">
                  <Receipt className="h-7 w-7 text-accent-foreground" />
                </div>
                <div className="flex-1">
                  <h3 className="font-semibold">Export Receipts</h3>
                  <p className="text-sm text-muted-foreground">
                    Export to CSV or YNAB
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Info Section */}
        <Card className="bg-card">
          <CardContent className="p-4 space-y-3">
            <h3 className="font-medium">How it works</h3>
            <div className="space-y-2">
              <div className="flex gap-3 text-sm">
                <span className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs">1</span>
                <p className="text-muted-foreground">Upload a photo of your receipt</p>
              </div>
              <div className="flex gap-3 text-sm">
                <span className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs">2</span>
                <p className="text-muted-foreground">Wait for automatic extraction</p>
              </div>
              <div className="flex gap-3 text-sm">
                <span className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs">3</span>
                <p className="text-muted-foreground">Review and confirm the details</p>
              </div>
              <div className="flex gap-3 text-sm">
                <span className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center text-primary font-semibold text-xs">4</span>
                <p className="text-muted-foreground">Export for your records</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      <BottomNavigation />
    </MobileLayout>
  );
};

export default Index;
