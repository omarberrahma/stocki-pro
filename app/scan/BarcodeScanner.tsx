'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, CameraOff, RefreshCw } from 'lucide-react';

type BarcodeResult = { rawValue: string };
type BarcodeDetectorInstance = {
  detect: (source: CanvasImageSource) => Promise<BarcodeResult[]>;
};
type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};

const WANTED_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'code_93',
  'itf',
  'codabar',
  'qr_code',
  'data_matrix',
];

export function BarcodeScanner({ onDetected }: { onDetected: (code: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopRef = useRef<() => void>(() => {});
  const lastRef = useRef({ code: '', at: 0 });
  const fallbackRef = useRef<{ stop: () => Promise<void> } | null>(null);
  const fallbackElementId = useRef(`barcode-scanner-${Math.random().toString(36).slice(2)}`);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [flash, setFlash] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);
  const [backCameras, setBackCameras] = useState<MediaDeviceInfo[]>([]);
  const [activeCameraIndex, setActiveCameraIndex] = useState(0);

  const emit = useCallback(
    (code: string) => {
      const now = Date.now();
      if (code === lastRef.current.code && now - lastRef.current.at < 2500) return;
      lastRef.current = { code, at: now };
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(120);
      setFlash(true);
      window.setTimeout(() => setFlash(false), 350);
      onDetected(code);
    },
    [onDetected],
  );

  const stop = useCallback(() => {
    stopRef.current();
    stopRef.current = () => {};
    setRunning(false);
    setUsingFallback(false);
  }, []);

  const startWithDevice = useCallback(
    async (deviceId?: string) => {
      setError('');
      stopRef.current();
      const video = videoRef.current;
      if (!video) return;

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1280 } }
            : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();

        const track = stream.getVideoTracks()[0];
        if (track && typeof track.getCapabilities === 'function') {
          try {
            const capabilities = track.getCapabilities() as MediaTrackCapabilities & { focusMode?: string[] };
            if (capabilities.focusMode?.includes('continuous')) {
              await track.applyConstraints({
                advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
              });
            }
          } catch {
            // Continuous focus is not available in every browser or camera.
          }
        }

        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const inputs = devices.filter((device) => device.kind === 'videoinput');
          const rearInputs = inputs.filter((device) => {
            const label = device.label.toLowerCase();
            return label.includes('back') || label.includes('rear') || label.includes('environment') || label.includes('0');
          });
          const cameras = rearInputs.length ? rearInputs : inputs;
          cameras.sort((a, b) => {
            const aWide = /ultra|0\.5|macro/i.test(a.label);
            const bWide = /ultra|0\.5|macro/i.test(b.label);
            return Number(aWide) - Number(bWide);
          });
          setBackCameras(cameras);
          const selectedIndex = cameras.findIndex((camera) => camera.deviceId === deviceId);
          if (selectedIndex >= 0) setActiveCameraIndex(selectedIndex);
        } catch {
          // Device enumeration is optional; the current stream can still scan.
        }

        const Detector = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
        if (Detector) {
          let formats = WANTED_FORMATS;
          try {
            const supported = await Detector.getSupportedFormats?.();
            if (supported?.length) formats = WANTED_FORMATS.filter((format) => supported.includes(format));
          } catch {
            // Use the requested format list when format discovery is unavailable.
          }

          const detector = new Detector({ formats });
          let alive = true;
          let timer: number | undefined;
          const tick = async () => {
            if (!alive) return;
            try {
              if (video.readyState >= 2) {
                const results = await detector.detect(video);
                if (results[0]?.rawValue) emit(results[0].rawValue);
              }
            } catch {
              // Ignore frames that are not ready for decoding.
            }
            if (alive) timer = window.setTimeout(tick, 150);
          };
          void tick();

          stopRef.current = () => {
            alive = false;
            if (timer !== undefined) window.clearTimeout(timer);
            stream.getTracks().forEach((cameraTrack) => cameraTrack.stop());
            video.srcObject = null;
          };
          setUsingFallback(false);
        } else {
          stream.getTracks().forEach((cameraTrack) => cameraTrack.stop());
          video.srcObject = null;
          setUsingFallback(true);
          const { Html5Qrcode } = await import('html5-qrcode');
          const scanner = new Html5Qrcode(fallbackElementId.current);
          fallbackRef.current = scanner;
          const camera = deviceId || { facingMode: 'environment' };
          await scanner.start(
            camera,
            { fps: 10, qrbox: { width: 220, height: 220 } },
            (decodedText) => emit(decodedText),
            () => {},
          );
          stopRef.current = () => {
            void scanner.stop().catch(() => {}).finally(() => {
              scanner.clear();
              fallbackRef.current = null;
            });
          };
        }

        setRunning(true);
      } catch (e) {
        const name = e instanceof Error ? e.name : '';
        setError(
          name === 'NotAllowedError'
            ? 'تم رفض الوصول إلى الكاميرا. اسمح بها من إعدادات المتصفح.'
            : 'تعذر تشغيل الكاميرا على هذا الجهاز. يمكنك كتابة الباركود يدوياً.',
        );
        streamCleanup(video);
        stop();
      }
    },
    [emit, stop],
  );

  const switchCamera = useCallback(() => {
    if (backCameras.length <= 1) return;
    const nextIndex = (activeCameraIndex + 1) % backCameras.length;
    setActiveCameraIndex(nextIndex);
    const target = backCameras[nextIndex];
    if (target?.deviceId) void startWithDevice(target.deviceId);
  }, [activeCameraIndex, backCameras, startWithDevice]);

  useEffect(() => () => stopRef.current(), []);

  return (
    <div className="overflow-hidden rounded-2xl bg-slate-950 text-white">
      <div className="relative aspect-[4/3] w-full sm:aspect-[16/9]">
        <video
          ref={videoRef}
          className={`absolute inset-0 h-full w-full object-cover ${usingFallback ? 'hidden' : ''}`}
          playsInline
          muted
        />
        {usingFallback && <div id={fallbackElementId.current} className="absolute inset-0 h-full w-full" />}
        {running ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className={`relative h-2/5 w-4/5 rounded-xl border-2 transition-colors ${flash ? 'border-emerald-400 bg-emerald-400/20' : 'border-white/70'}`}>
              <div className="absolute inset-x-3 top-1/2 h-0.5 animate-pulse rounded-full bg-amber-400 shadow-[0_0_12px_#fbbf24]" />
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10">
              <Camera className="h-7 w-7" />
            </div>
            <p className="text-sm text-slate-300">وجّه الكاميرا نحو الباركود</p>
            <button type="button" className="inline-flex items-center gap-2 rounded-xl bg-amber-400 px-5 py-3 font-bold text-slate-950" onClick={() => void startWithDevice()}>
              <Camera className="h-5 w-5" />
              تشغيل الكاميرا
            </button>
            {error && <p className="max-w-xs text-xs font-bold text-amber-300">{error}</p>}
          </div>
        )}
      </div>

      {running && (
        <div className="flex items-center justify-between px-4 py-2 text-xs text-slate-300">
          <span className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            الكاميرا تعمل
          </span>
          <div className="flex items-center gap-2">
            {backCameras.length > 1 && (
              <button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-white/10" onClick={switchCamera}>
                <RefreshCw className="h-3.5 w-3.5" /> تبديل العدسة
              </button>
            )}
            <button type="button" className="inline-flex items-center gap-1 rounded-lg px-2 py-1 hover:bg-white/10" onClick={stop}>
              <CameraOff className="h-4 w-4" /> إيقاف
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function streamCleanup(video: HTMLVideoElement) {
  const stream = video.srcObject;
  if (stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop());
  video.srcObject = null;
}
