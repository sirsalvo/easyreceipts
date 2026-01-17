import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { toast } from '@/hooks/use-toast';
import { createReceipt, uploadToPresignedUrl } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import { Upload as UploadIcon, Camera, Image, ArrowLeft, Loader2 } from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import BottomNavigation from '@/components/BottomNavigation';

const Upload = () => {
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  if (!isAuthenticated()) {
    navigate('/settings');
    return null;
  }

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast({
          title: 'Invalid file',
          description: 'Please select an image file',
          variant: 'destructive',
        });
        return;
      }

      setSelectedFile(file);
      const reader = new FileReader();
      reader.onload = (e) => {
        setPreviewUrl(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile) {
      toast({
        title: 'No file selected',
        description: 'Please select an image first',
        variant: 'destructive',
      });
      return;
    }

    setIsUploading(true);

    try {
      // Create receipt and get presigned URL
      const { receiptId, uploadUrl } = await createReceipt();

      // Upload to presigned URL
      await uploadToPresignedUrl(uploadUrl, selectedFile);

      toast({
        title: 'Upload successful',
        description: 'Your receipt is being processed',
      });

      // Navigate to processing page
      navigate(`/processing/${receiptId}`);
    } catch (error) {
      toast({
        title: 'Upload failed',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      });
    } finally {
      setIsUploading(false);
    }
  };

  const openFileDialog = (capture?: boolean) => {
    if (fileInputRef.current) {
      if (capture) {
        fileInputRef.current.setAttribute('capture', 'environment');
      } else {
        fileInputRef.current.removeAttribute('capture');
      }
      fileInputRef.current.click();
    }
  };

  return (
    <MobileLayout>
      <div className="p-4 space-y-4">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/')}
            className="shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex items-center gap-2">
            <UploadIcon className="h-6 w-6 text-primary" />
            <h1 className="text-xl font-semibold">Upload Receipt</h1>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileSelect}
          className="hidden"
        />

        {!previewUrl ? (
          <Card className="border-dashed border-2">
            <CardContent className="p-8 space-y-6">
              <div className="text-center space-y-2">
                <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <UploadIcon className="h-8 w-8 text-primary" />
                </div>
                <h2 className="text-lg font-medium">Add Receipt Image</h2>
                <p className="text-sm text-muted-foreground">
                  Take a photo or choose from gallery
                </p>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  className="h-20 flex-col gap-2"
                  onClick={() => openFileDialog(true)}
                >
                  <Camera className="h-6 w-6" />
                  <span className="text-sm">Take Photo</span>
                </Button>
                <Button
                  variant="outline"
                  className="h-20 flex-col gap-2"
                  onClick={() => openFileDialog(false)}
                >
                  <Image className="h-6 w-6" />
                  <span className="text-sm">Gallery</span>
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-4 space-y-4">
              <div className="relative rounded-lg overflow-hidden bg-muted/30">
                <img
                  src={previewUrl}
                  alt="Receipt preview"
                  className="w-full h-auto max-h-[50vh] object-contain"
                />
              </div>

              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="truncate">{selectedFile?.name}</span>
                <span className="shrink-0">
                  ({(selectedFile?.size ?? 0 / 1024).toFixed(1)} KB)
                </span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setSelectedFile(null);
                    setPreviewUrl(null);
                  }}
                  disabled={isUploading}
                >
                  Change
                </Button>
                <Button onClick={handleUpload} disabled={isUploading}>
                  {isUploading ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    'Upload'
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
      <BottomNavigation />
    </MobileLayout>
  );
};

export default Upload;
