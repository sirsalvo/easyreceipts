import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/hooks/use-toast';
import { getReceipts, Receipt, updateReceipt } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import { useUserStatus } from '@/hooks/useUserStatus';
import { cn, formatCurrency } from '@/lib/utils';
import { getYNABConfig, exportToYNAB } from '@/lib/ynab';
import { markAsExportedToYNAB } from '@/lib/ynabExportStore';
import { 
  ArrowLeft, 
  Download, 
  FileSpreadsheet, 
  Calendar,
  CalendarIcon,
  Loader2,
  CheckCircle2,
  Filter
} from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import BottomNavigation from '@/components/BottomNavigation';
import { format, subDays, startOfMonth, endOfMonth, subMonths, differenceInDays } from 'date-fns';
import { it } from 'date-fns/locale';

type DateRange = 'all' | 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom';
type ExportMode = 'csv' | 'ynab';

const MAX_CUSTOM_RANGE_DAYS = 365;

const dateRangeOptions: { value: DateRange; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'last7', label: '7 days' },
  { value: 'last30', label: '30 days' },
  { value: 'thisMonth', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
  { value: 'custom', label: 'Custom' },
];

const Export = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedReceiptId = searchParams.get('receiptId');
  
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>('all');
  const [customStartDate, setCustomStartDate] = useState<Date | undefined>(undefined);
  const [customEndDate, setCustomEndDate] = useState<Date | undefined>(undefined);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAll, setSelectAll] = useState(true);
  const [exportMode, setExportMode] = useState<ExportMode>('csv');
  const { status: userStatus } = useUserStatus();

  const authenticated = isAuthenticated();
  const isExpired = userStatus === 'expired';

  useEffect(() => {
    if (!authenticated) {
      navigate('/login');
      return;
    }
    fetchReceipts();
  }, [authenticated, navigate]);

  const fetchReceipts = async () => {
    try {
      const { receipts: data } = await getReceipts({ limit: 1000 });
      // Only show confirmed receipts
      const confirmed = data.filter((r) => r.status === 'CONFIRMED');
      setReceipts(confirmed);
      
      // If a specific receipt is preselected, only select that one
      if (preselectedReceiptId) {
        const exists = confirmed.some((r) => r.receiptId === preselectedReceiptId);
        if (exists) {
          setSelectedIds(new Set([preselectedReceiptId]));
          setSelectAll(false);
        } else {
          // Preselected receipt not found in confirmed, select all
          setSelectedIds(new Set(confirmed.map((r) => r.receiptId)));
        }
      } else {
        // Select all by default
        setSelectedIds(new Set(confirmed.map((r) => r.receiptId)));
      }
    } catch (error) {
      toast({
        title: 'Error loading receipts',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const getFilteredReceipts = () => {
    const now = new Date();
    let startDate: Date | null = null;
    let endDate: Date | null = null;

    switch (dateRange) {
      case 'last7':
        startDate = subDays(now, 7);
        break;
      case 'last30':
        startDate = subDays(now, 30);
        break;
      case 'thisMonth':
        startDate = startOfMonth(now);
        endDate = endOfMonth(now);
        break;
      case 'lastMonth':
        const lastMonth = subMonths(now, 1);
        startDate = startOfMonth(lastMonth);
        endDate = endOfMonth(lastMonth);
        break;
      case 'custom':
        if (customStartDate) {
          startDate = customStartDate;
        }
        if (customEndDate) {
          endDate = customEndDate;
          // Set end date to end of day
          endDate.setHours(23, 59, 59, 999);
        }
        break;
      default:
        break;
    }

    return receipts.filter((receipt) => {
      const receiptDate = new Date(receipt.date || receipt.createdAt || 0);
      if (startDate && receiptDate < startDate) return false;
      if (endDate && receiptDate > endDate) return false;
      return true;
    });
  };

  const handleCustomDateChange = (type: 'start' | 'end', date: Date | undefined) => {
    if (!date) {
      if (type === 'start') setCustomStartDate(undefined);
      else setCustomEndDate(undefined);
      return;
    }

    const otherDate = type === 'start' ? customEndDate : customStartDate;
    
    if (otherDate) {
      const daysDiff = type === 'start' 
        ? differenceInDays(otherDate, date)
        : differenceInDays(date, customStartDate!);
      
      if (daysDiff > MAX_CUSTOM_RANGE_DAYS) {
        toast({
          title: 'Range troppo ampio',
          description: `Il range massimo selezionabile è di ${MAX_CUSTOM_RANGE_DAYS} giorni`,
          variant: 'destructive',
        });
        return;
      }
      
      if (daysDiff < 0) {
        toast({
          title: 'Date non valide',
          description: 'La data di fine deve essere successiva a quella di inizio',
          variant: 'destructive',
        });
        return;
      }
    }

    if (type === 'start') {
      setCustomStartDate(date);
    } else {
      setCustomEndDate(date);
    }
  };

  const filteredReceipts = getFilteredReceipts();
  
  // For YNAB mode, exclude already exported receipts
  const exportableReceipts = exportMode === 'ynab' 
    ? filteredReceipts.filter((r) => !r.ynabExportedAt)
    : filteredReceipts;
  const alreadyExportedCount = filteredReceipts.filter((r) => !!r.ynabExportedAt).length;
  
  const selectedReceipts = exportableReceipts.filter((r) => selectedIds.has(r.receiptId));

  const handleSelectAll = (checked: boolean) => {
    setSelectAll(checked);
    if (checked) {
      setSelectedIds(new Set(exportableReceipts.map((r) => r.receiptId)));
    } else {
      setSelectedIds(new Set());
    }
  };

  const handleSelectReceipt = (receiptId: string, checked: boolean) => {
    const newSet = new Set(selectedIds);
    if (checked) {
      newSet.add(receiptId);
    } else {
      newSet.delete(receiptId);
    }
    setSelectedIds(newSet);
    setSelectAll(newSet.size === exportableReceipts.length);
  };

  // Update selection when export mode changes
  useEffect(() => {
    if (exportMode === 'ynab') {
      // Remove already exported receipts from selection
      const newSelection = new Set(
        [...selectedIds].filter((id) => {
          const receipt = receipts.find((r) => r.receiptId === id);
          return receipt && !receipt.ynabExportedAt;
        })
      );
      setSelectedIds(newSelection);
      setSelectAll(newSelection.size === exportableReceipts.length && exportableReceipts.length > 0);
    }
  }, [exportMode]);

  const handleExportCSV = () => {
    if (selectedReceipts.length === 0) {
      toast({
        title: 'No receipts selected',
        description: 'Please select at least one receipt to export',
        variant: 'destructive',
      });
      return;
    }

    setExporting(true);

    try {
      // CSV headers
      const headers = ['Date', 'Merchant', 'Total', 'VAT', 'VAT Rate', 'Category', 'Notes', 'Receipt ID'];
      
      // CSV rows
      const rows = selectedReceipts.map((receipt) => [
        receipt.date || '',
        receipt.payee || '',
        receipt.total?.toString() || '',
        receipt.vat?.toString() || '',
        receipt.vatRate || '',
        receipt.category || '',
        (receipt.notes || '').replace(/"/g, '""'), // Escape quotes
        receipt.receiptId,
      ]);

      // Build CSV content
      const csvContent = [
        headers.join(','),
        ...rows.map((row) => 
          row.map((cell) => `"${cell}"`).join(',')
        ),
      ].join('\n');

      // Create and download file
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `receipts-export-${format(new Date(), 'yyyy-MM-dd')}.csv`);
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast({
        title: 'Export complete',
        description: `Exported ${selectedReceipts.length} receipt(s) to CSV`,
      });
    } catch (error) {
      toast({
        title: 'Export failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      });
    } finally {
      setExporting(false);
    }
  };

  const handleExportYNAB = async () => {
    if (selectedReceipts.length === 0) {
      toast({
        title: 'No receipts selected',
        description: 'Please select at least one receipt to export',
        variant: 'destructive',
      });
      return;
    }

    const config = getYNABConfig();
    
    if (!config.token) {
      toast({
        title: 'Missing YNAB token',
        description: 'Configure your YNAB token in Settings',
        variant: 'destructive',
      });
      return;
    }

    if (!config.accountId) {
      toast({
        title: 'Missing Account ID',
        description: 'Configure your YNAB Account ID in Settings',
        variant: 'destructive',
      });
      return;
    }

    setExporting(true);

    try {
      const result = await exportToYNAB(selectedReceipts, config);
      
      // Mark receipts as exported to YNAB (save to backend)
      const exportedAt = new Date().toISOString();
      await Promise.all(
        selectedReceipts.map((r) =>
          updateReceipt(r.receiptId, { ynabExportedAt: exportedAt })
        )
      );
      
      // Also update local storage for immediate UI feedback
      markAsExportedToYNAB(selectedReceipts.map((r) => r.receiptId));
      
      toast({
        title: 'YNAB export complete',
        description: `${result.count} transaction(s) created in YNAB`,
      });
    } catch (error) {
      toast({
        title: 'YNAB export failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      });
    } finally {
      setExporting(false);
    }
  };

  const handleExport = () => {
    if (exportMode === 'csv') {
      handleExportCSV();
    } else {
      handleExportYNAB();
    }
  };

  const totalAmount = selectedReceipts.reduce((sum, r) => sum + (parseFloat(String(r.total)) || 0), 0);
  const totalVat = selectedReceipts.reduce((sum, r) => sum + (parseFloat(String(r.vat)) || 0), 0);

  if (loading) {
    return (
      <MobileLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading receipts...</p>
        </div>
        <BottomNavigation />
      </MobileLayout>
    );
  }

  return (
    <MobileLayout>
      <div className="p-4 space-y-4 pb-32">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/receipts')}
            className="shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <FileSpreadsheet className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-semibold">Export Receipts</h1>
          </div>
        </div>

        {receipts.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <CheckCircle2 className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground">
                No confirmed receipts to export
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                Confirm some receipts first to export them
              </p>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Export Mode Selection */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Export Mode</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex gap-2">
                  <Button
                    variant={exportMode === 'csv' ? 'default' : 'outline'}
                    className="flex-1"
                    onClick={() => setExportMode('csv')}
                  >
                    <Download className="h-4 w-4 mr-2" />
                    CSV
                  </Button>
                  <Button
                    variant={exportMode === 'ynab' ? 'default' : 'outline'}
                    className="flex-1"
                    onClick={() => setExportMode('ynab')}
                  >
                    <div className="w-4 h-4 rounded bg-blue-500 flex items-center justify-center mr-2">
                      <span className="text-white text-[10px] font-bold">Y</span>
                    </div>
                    YNAB
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Date Range Filter */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-primary" />
                  <CardTitle className="text-base">Date Range</CardTitle>
                </div>
                <CardDescription className="text-xs">
                  {dateRange === 'custom' && `Max ${MAX_CUSTOM_RANGE_DAYS} days`}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  {dateRangeOptions.map((option) => (
                    <Button
                      key={option.value}
                      variant={dateRange === option.value ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => {
                        setDateRange(option.value);
                        // Reset selection when changing filter
                        if (option.value !== 'custom') {
                          const newFiltered = getFilteredReceipts();
                          if (selectAll) {
                            setSelectedIds(new Set(newFiltered.map((r) => r.receiptId)));
                          }
                        }
                      }}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
                
                {/* Custom Date Pickers */}
                {dateRange === 'custom' && (
                  <div className="grid grid-cols-2 gap-3 pt-2">
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            className={cn(
                              "w-full justify-start text-left font-normal h-9",
                              !customStartDate && "text-muted-foreground"
                            )}
                          >
                            <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                            {customStartDate ? format(customStartDate, "dd/MM/yy") : "Select"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <CalendarComponent
                            mode="single"
                            selected={customStartDate}
                            onSelect={(date) => handleCustomDateChange('start', date)}
                            disabled={(date) => date > new Date()}
                            initialFocus
                            className="p-3 pointer-events-auto"
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            className={cn(
                              "w-full justify-start text-left font-normal h-9",
                              !customEndDate && "text-muted-foreground"
                            )}
                          >
                            <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                            {customEndDate ? format(customEndDate, "dd/MM/yy") : "Select"}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className="w-auto p-0" align="start">
                          <CalendarComponent
                            mode="single"
                            selected={customEndDate}
                            onSelect={(date) => handleCustomDateChange('end', date)}
                            disabled={(date) => 
                              date > new Date() || 
                              (customStartDate ? date < customStartDate : false)
                            }
                            initialFocus
                            className="p-3 pointer-events-auto"
                          />
                        </PopoverContent>
                      </Popover>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Summary */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Export Summary</CardTitle>
                <CardDescription>
                  {selectedReceipts.length} of {exportableReceipts.length} receipts selected
                  {exportMode === 'ynab' && alreadyExportedCount > 0 && (
                    <span className="block text-xs mt-1">
                      ({alreadyExportedCount} already exported to YNAB)
                    </span>
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-3 bg-muted/30 rounded-lg">
                    <p className="text-sm text-muted-foreground">Total</p>
                    <p className="text-xl font-bold">{formatCurrency(totalAmount)}</p>
                  </div>
                  <div className="p-3 bg-muted/30 rounded-lg">
                    <p className="text-sm text-muted-foreground">VAT</p>
                    <p className="text-xl font-bold">{formatCurrency(totalVat)}</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Receipt Selection */}
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Select Receipts</CardTitle>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id="selectAll"
                      checked={selectAll}
                      onCheckedChange={handleSelectAll}
                      disabled={exportableReceipts.length === 0}
                    />
                    <Label htmlFor="selectAll" className="text-sm">
                      All
                    </Label>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-2 max-h-[300px] overflow-y-auto">
                {exportableReceipts.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    {exportMode === 'ynab' 
                      ? 'All receipts have already been exported to YNAB'
                      : 'No receipts match the selected filters'}
                  </p>
                ) : (
                  exportableReceipts.map((receipt) => (
                    <div
                      key={receipt.receiptId}
                      className="flex items-center gap-3 p-3 rounded-lg bg-muted/20 hover:bg-muted/40 transition-colors"
                    >
                      <Checkbox
                        checked={selectedIds.has(receipt.receiptId)}
                        onCheckedChange={(checked) => 
                          handleSelectReceipt(receipt.receiptId, checked as boolean)
                        }
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">
                          {receipt.payee || 'Unknown'}
                        </p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Calendar className="h-3 w-3" />
                          <span>{receipt.date || 'No date'}</span>
                        </div>
                      </div>
                      <p className="font-semibold">{formatCurrency(receipt.total)}</p>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Fixed Bottom Actions */}
      {receipts.length > 0 && (
        <div className="fixed bottom-16 left-0 right-0 p-4 bg-background border-t border-border">
          <div className="max-w-lg mx-auto">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="w-full">
                  <Button
                    className="w-full"
                    onClick={handleExport}
                    disabled={exporting || selectedReceipts.length === 0 || isExpired}
                  >
                    {exporting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : exportMode === 'csv' ? (
                      <Download className="h-4 w-4 mr-2" />
                    ) : (
                      <div className="w-4 h-4 rounded bg-blue-500 flex items-center justify-center mr-2">
                        <span className="text-white text-[10px] font-bold">Y</span>
                      </div>
                    )}
                    Export {selectedReceipts.length} Receipt(s) {exportMode === 'csv' ? 'to CSV' : 'to YNAB'}
                  </Button>
                </span>
              </TooltipTrigger>
              {isExpired && (
                <TooltipContent>
                  <p>Your free trial has ended. Activate a subscription to export receipts.</p>
                </TooltipContent>
              )}
            </Tooltip>
          </div>
        </div>
      )}
      <BottomNavigation />
    </MobileLayout>
  );
};

export default Export;
