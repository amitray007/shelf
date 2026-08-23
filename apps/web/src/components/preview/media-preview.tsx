// biome-ignore-all lint/a11y/noNoninteractiveTabindex: The media and PDF surfaces expose keyboard shortcuts from their focusable regions.
// biome-ignore-all lint/a11y/useMediaCaption: Caption tracks are optional because source metadata may not include a transcript.

import { ArrowClockwiseIcon } from '@phosphor-icons/react/ArrowClockwise';
import { ArrowCounterClockwiseIcon } from '@phosphor-icons/react/ArrowCounterClockwise';
import { ArrowsOutIcon } from '@phosphor-icons/react/ArrowsOut';
import { CaretDownIcon } from '@phosphor-icons/react/CaretDown';
import { PauseIcon } from '@phosphor-icons/react/Pause';
import { PictureInPictureIcon } from '@phosphor-icons/react/PictureInPicture';
import { PlayIcon } from '@phosphor-icons/react/Play';
import { SpeakerHighIcon } from '@phosphor-icons/react/SpeakerHigh';
import { SpeakerSlashIcon } from '@phosphor-icons/react/SpeakerSlash';
import { SpinnerGapIcon } from '@phosphor-icons/react/SpinnerGap';
import { WarningCircleIcon } from '@phosphor-icons/react/WarningCircle';
import type { CSSProperties, KeyboardEvent, SyntheticEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ElevenLabsWaveform } from './elevenlabs-waveform.js';
import {
  bufferedMediaTime,
  clampMediaTime,
  formatMediaTime,
  isPlaybackRate,
  mediaPercent,
  mediaTimeFromKey,
  PLAYBACK_RATES,
  type PlaybackRate,
} from './media-preview-utils.js';
import './media-preview.css';

type MediaStatus = 'loading' | 'ready' | 'error';

interface MediaPreviewBaseProps {
  /** A safe preview URL supplied by the caller. This component never adds credentials. */
  readonly src: string;
  readonly title?: string | undefined;
  readonly className?: string | undefined;
  /** Hide the inner filename heading when an outer share toolbar owns identity. */
  readonly showFileIdentity?: boolean | undefined;
  readonly captions?: MediaCaptionTrack | undefined;
}

export interface MediaCaptionTrack {
  readonly src: string;
  readonly srcLang: string;
  readonly label: string;
  readonly default?: boolean | undefined;
}

export interface AudioPreviewProps extends MediaPreviewBaseProps {
  readonly initialVolume?: number | undefined;
  readonly initialPlaybackRate?: PlaybackRate | undefined;
}

export interface VideoPreviewProps extends MediaPreviewBaseProps {
  /** A safe poster URL supplied by the caller. */
  readonly poster?: string | undefined;
  /** Set to true when the browser's native controls are preferred as a fallback. */
  readonly nativeControls?: boolean | undefined;
  /** A number such as 16 / 9. The ratio updates from metadata when available. */
  readonly aspectRatio?: number | undefined;
  readonly initialVolume?: number | undefined;
  readonly initialPlaybackRate?: PlaybackRate | undefined;
}

interface MediaController {
  readonly mediaRef: React.RefObject<HTMLMediaElement | null>;
  readonly status: MediaStatus;
  readonly errorMessage: string | undefined;
  readonly isPlaying: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly buffered: number;
  readonly volume: number;
  readonly muted: boolean;
  readonly playbackRate: PlaybackRate;
  readonly togglePlayback: () => void;
  readonly seek: (value: number) => void;
  readonly setVolume: (value: number) => void;
  readonly toggleMute: () => void;
  readonly setPlaybackRate: (value: number) => void;
  readonly reload: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onLoadedMetadata: (event: SyntheticEvent<HTMLMediaElement>) => void;
  readonly onDurationChange: (event: SyntheticEvent<HTMLMediaElement>) => void;
  readonly onTimeUpdate: (event: SyntheticEvent<HTMLMediaElement>) => void;
  readonly onProgress: (event: SyntheticEvent<HTMLMediaElement>) => void;
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onEnded: () => void;
  readonly onWaiting: () => void;
  readonly onCanPlay: () => void;
  readonly onError: (event: SyntheticEvent<HTMLMediaElement>) => void;
}

function initialVolumeValue(value: number | undefined): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value as number)) : 1;
}

function initialRateValue(value: PlaybackRate | undefined): PlaybackRate {
  return value ?? 1;
}

function mediaDuration(media: HTMLMediaElement): number {
  return Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0;
}

function useMediaController(
  src: string,
  initialVolume: number | undefined,
  initialPlaybackRate: PlaybackRate | undefined,
): MediaController {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const lastVolumeRef = useRef(Math.max(initialVolumeValue(initialVolume), 0.1));
  const [status, setStatus] = useState<MediaStatus>('loading');
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [volume, setVolumeState] = useState(initialVolumeValue(initialVolume));
  const [muted, setMuted] = useState(false);
  const [playbackRate, setPlaybackRateState] = useState(initialRateValue(initialPlaybackRate));

  useEffect(() => {
    const media = mediaRef.current;
    if (media === null) return;
    media.volume = volume;
    media.muted = muted;
    media.playbackRate = playbackRate;
  }, [muted, playbackRate, volume]);

  useEffect(() => {
    const media = mediaRef.current;
    if (media === null) return;
    media.src = src;
    media.pause();
    media.currentTime = 0;
    setStatus('loading');
    setErrorMessage(undefined);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setBuffered(0);
    media.load();
  }, [src]);

  const updateBuffered = useCallback(
    (media: HTMLMediaElement, nextDuration = duration) => {
      setBuffered(bufferedMediaTime(media.buffered, media.currentTime, nextDuration));
    },
    [duration],
  );

  const onLoadedMetadata = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
    const media = event.currentTarget;
    const nextDuration = mediaDuration(media);
    setDuration(nextDuration);
    setCurrentTime(clampMediaTime(media.currentTime, nextDuration));
    setBuffered(bufferedMediaTime(media.buffered, media.currentTime, nextDuration));
    setStatus('ready');
    setErrorMessage(undefined);
  }, []);

  const onDurationChange = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
    const nextDuration = mediaDuration(event.currentTarget);
    setDuration(nextDuration);
    setCurrentTime((value) => clampMediaTime(value, nextDuration));
  }, []);

  const onTimeUpdate = useCallback(
    (event: SyntheticEvent<HTMLMediaElement>) => {
      const media = event.currentTarget;
      const nextDuration = mediaDuration(media);
      setCurrentTime(clampMediaTime(media.currentTime, nextDuration));
      updateBuffered(media, nextDuration);
    },
    [updateBuffered],
  );

  const onProgress = useCallback(
    (event: SyntheticEvent<HTMLMediaElement>) => {
      const media = event.currentTarget;
      updateBuffered(media, mediaDuration(media));
    },
    [updateBuffered],
  );

  const togglePlayback = useCallback(() => {
    const media = mediaRef.current;
    if (media === null || status === 'error') return;
    if (media.paused) {
      void media.play().catch((error: unknown) => {
        setStatus('error');
        setErrorMessage(error instanceof Error ? error.message : 'Playback was blocked.');
      });
    } else {
      media.pause();
    }
  }, [status]);

  const seek = useCallback(
    (value: number) => {
      const media = mediaRef.current;
      if (media === null) return;
      const nextTime = clampMediaTime(value, duration);
      media.currentTime = nextTime;
      setCurrentTime(nextTime);
    },
    [duration],
  );

  const setVolume = useCallback((value: number) => {
    const nextVolume = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    const media = mediaRef.current;
    setVolumeState(nextVolume);
    if (nextVolume > 0) lastVolumeRef.current = nextVolume;
    setMuted(nextVolume === 0);
    if (media !== null) {
      media.volume = nextVolume;
      media.muted = nextVolume === 0;
    }
  }, []);

  const toggleMute = useCallback(() => {
    const media = mediaRef.current;
    const nextMuted = !muted;
    const nextVolume = nextMuted ? volume : Math.max(lastVolumeRef.current, 0.1);
    setMuted(nextMuted);
    if (!nextMuted) setVolumeState(nextVolume);
    if (media !== null) {
      media.muted = nextMuted;
      if (!nextMuted) media.volume = nextVolume;
    }
  }, [muted, volume]);

  const setPlaybackRate = useCallback((value: number) => {
    if (!isPlaybackRate(value)) return;
    setPlaybackRateState(value);
    if (mediaRef.current !== null) mediaRef.current.playbackRate = value;
  }, []);

  const reload = useCallback(() => {
    const media = mediaRef.current;
    if (media === null) return;
    media.pause();
    media.load();
    setStatus('loading');
    setErrorMessage(undefined);
    setIsPlaying(false);
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.target !== event.currentTarget) return;
      const media = mediaRef.current;
      if (media === null) return;
      if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        togglePlayback();
        return;
      }
      if (event.key.toLowerCase() === 'm') {
        event.preventDefault();
        toggleMute();
        return;
      }
      const nextTime = mediaTimeFromKey(event.key, media.currentTime, duration);
      if (nextTime !== null) {
        event.preventDefault();
        seek(nextTime);
      }
    },
    [duration, seek, toggleMute, togglePlayback],
  );

  const onError = useCallback((event: SyntheticEvent<HTMLMediaElement>) => {
    const message = event.currentTarget.error?.message;
    setStatus('error');
    setIsPlaying(false);
    setErrorMessage(message && message.length > 0 ? message : 'The media could not be loaded.');
  }, []);

  return {
    mediaRef,
    status,
    errorMessage,
    isPlaying,
    currentTime,
    duration,
    buffered,
    volume,
    muted,
    playbackRate,
    togglePlayback,
    seek,
    setVolume,
    toggleMute,
    setPlaybackRate,
    reload,
    onKeyDown,
    onLoadedMetadata,
    onDurationChange,
    onTimeUpdate,
    onProgress,
    onPlay: () => {
      setIsPlaying(true);
      setStatus('ready');
    },
    onPause: () => setIsPlaying(false),
    onEnded: () => setIsPlaying(false),
    onWaiting: () => setStatus('loading'),
    onCanPlay: () => setStatus('ready'),
    onError,
  };
}

function ButtonIcon({
  label,
  onClick,
  disabled = false,
  pressed,
  className,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly className?: string | undefined;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={['media-preview-button', className].filter(Boolean).join(' ')}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function previewWaveformData(label: string): readonly number[] {
  let seed = 2_166_136_261;
  for (const character of label) {
    seed ^= character.charCodeAt(0);
    seed = Math.imul(seed, 16_777_619);
  }

  return Array.from({ length: 112 }, (_, index) => {
    seed = Math.imul(seed ^ (seed >>> 15), 2_246_822_519);
    seed = Math.imul(seed ^ (seed >>> 13), 3_266_489_917);
    const noise = ((seed ^ (seed >>> 16)) >>> 0) / 4_294_967_295;
    const envelope = 0.64 + 0.24 * Math.sin((index / 111) * Math.PI);
    const rhythm = 0.14 * Math.sin(index * 0.83) + 0.1 * Math.sin(index * 0.31);
    return Math.min(1, Math.max(0.12, noise * envelope + rhythm));
  });
}

function AudioMediaControls({
  controller,
  label,
  showFileIdentity,
}: {
  readonly controller: MediaController;
  readonly label: string;
  readonly showFileIdentity: boolean;
}) {
  const waveformData = useMemo(() => previewWaveformData(label), [label]);
  const currentPercent = mediaPercent(controller.currentTime, controller.duration);
  const bufferedPercent = mediaPercent(controller.buffered, controller.duration);
  const timelineStyle = {
    '--media-current': `${currentPercent}%`,
    '--media-buffered': `${bufferedPercent}%`,
  } as CSSProperties;
  const canSeek = controller.duration > 0 && controller.status !== 'error';
  const timeLabel = `${formatMediaTime(controller.currentTime)} of ${formatMediaTime(controller.duration)}`;
  const statusLabel =
    controller.status === 'loading'
      ? 'Loading audio'
      : controller.status === 'error'
        ? (controller.errorMessage ?? 'Unable to load audio')
        : undefined;

  return (
    <section aria-label={`${label} controls`} className="audio-player-controls">
      <div className="audio-player-display">
        <div className="audio-player-heading">
          <div className="audio-player-identity">
            <span className="media-preview-kind">Audio</span>
            {showFileIdentity ? <h2 className="media-preview-title">{label}</h2> : null}
          </div>
          <span className="audio-player-streaming">Streaming</span>
        </div>

        <div className="audio-player-waveform-shell">
          <ElevenLabsWaveform
            barGap={3}
            barHeight={5}
            barRadius={2}
            barWidth={3}
            className="audio-player-waveform"
            data={waveformData}
            fadeWidth={20}
            height={72}
          />
        </div>

        <div className="audio-player-timeline-row">
          <output aria-label={`${label} current time`} className="audio-player-time">
            {formatMediaTime(controller.currentTime)}
          </output>
          <div className="media-preview-timeline" style={timelineStyle}>
            <span aria-hidden="true" className="media-preview-timeline-buffered" />
            <span aria-hidden="true" className="media-preview-timeline-progress" />
            <input
              aria-label="Seek audio"
              aria-valuetext={timeLabel}
              className="media-preview-seek"
              disabled={!canSeek}
              max={controller.duration || 0}
              min={0}
              onChange={(event) => controller.seek(Number(event.currentTarget.value))}
              step={0.1}
              type="range"
              value={controller.currentTime}
            />
          </div>
          <output aria-label={`${label} duration`} className="audio-player-time">
            {formatMediaTime(controller.duration)}
          </output>
        </div>
      </div>

      <fieldset aria-label="Playback controls" className="audio-player-transport">
        <ButtonIcon
          className="audio-player-skip"
          disabled={!canSeek}
          label="Back 10 seconds"
          onClick={() => controller.seek(controller.currentTime - 10)}
        >
          <ArrowCounterClockwiseIcon aria-hidden="true" size={19} />
          <span aria-hidden="true" className="audio-player-skip-value">
            10
          </span>
        </ButtonIcon>
        <ButtonIcon
          className="audio-player-play"
          disabled={controller.status === 'error'}
          label={controller.isPlaying ? 'Pause audio' : 'Play audio'}
          onClick={controller.togglePlayback}
        >
          {controller.isPlaying ? (
            <PauseIcon aria-hidden="true" size={24} weight="fill" />
          ) : (
            <PlayIcon aria-hidden="true" size={24} weight="fill" />
          )}
        </ButtonIcon>
        <ButtonIcon
          className="audio-player-skip"
          disabled={!canSeek}
          label="Forward 10 seconds"
          onClick={() => controller.seek(controller.currentTime + 10)}
        >
          <ArrowClockwiseIcon aria-hidden="true" size={19} />
          <span aria-hidden="true" className="audio-player-skip-value">
            10
          </span>
        </ButtonIcon>
      </fieldset>

      <div className="audio-player-settings">
        <div className="audio-player-volume-control">
          <ButtonIcon
            label={controller.muted ? 'Unmute audio' : 'Mute audio'}
            onClick={controller.toggleMute}
            pressed={controller.muted}
          >
            {controller.muted || controller.volume === 0 ? (
              <SpeakerSlashIcon aria-hidden="true" size={18} />
            ) : (
              <SpeakerHighIcon aria-hidden="true" size={18} />
            )}
          </ButtonIcon>
          <input
            aria-label={`${label} volume`}
            className="media-preview-volume"
            max={1}
            min={0}
            onChange={(event) => controller.setVolume(Number(event.currentTarget.value))}
            step={0.01}
            type="range"
            value={controller.muted ? 0 : controller.volume}
          />
          <output className="audio-player-volume-value">
            {Math.round((controller.muted ? 0 : controller.volume) * 100)}%
          </output>
        </div>

        <label className="media-preview-speed">
          <span className="media-preview-speed-label">Speed</span>
          <select
            aria-label={`${label} playback speed`}
            onChange={(event) => controller.setPlaybackRate(Number(event.currentTarget.value))}
            value={controller.playbackRate}
          >
            {PLAYBACK_RATES.map((rate) => (
              <option key={rate} value={rate}>
                {rate}×
              </option>
            ))}
          </select>
          <CaretDownIcon aria-hidden="true" className="media-preview-speed-icon" size={13} />
        </label>
      </div>

      <div aria-live="polite" className="media-preview-status audio-player-status" role="status">
        {statusLabel !== undefined && (
          <>
            {controller.status === 'loading' ? (
              <SpinnerGapIcon aria-hidden="true" className="media-preview-spinner" size={15} />
            ) : (
              <WarningCircleIcon aria-hidden="true" size={15} />
            )}
            <span>{statusLabel}</span>
            {controller.status === 'error' && (
              <button className="media-preview-retry" onClick={controller.reload} type="button">
                Try again
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function MediaControls({
  controller,
  label,
  kind,
  onFullscreen,
  onPictureInPicture,
  supportsFullscreen,
  supportsPictureInPicture,
}: {
  readonly controller: MediaController;
  readonly label: string;
  readonly kind: 'audio' | 'video';
  readonly onFullscreen?: (() => void) | undefined;
  readonly onPictureInPicture?: (() => void) | undefined;
  readonly supportsFullscreen?: boolean | undefined;
  readonly supportsPictureInPicture?: boolean | undefined;
}) {
  const currentPercent = mediaPercent(controller.currentTime, controller.duration);
  const bufferedPercent = mediaPercent(controller.buffered, controller.duration);
  const timelineStyle = {
    '--media-current': `${currentPercent}%`,
    '--media-buffered': `${bufferedPercent}%`,
  } as CSSProperties;
  const timeLabel = `${formatMediaTime(controller.currentTime)} of ${formatMediaTime(controller.duration)}`;
  const statusLabel =
    controller.status === 'loading'
      ? 'Loading'
      : controller.status === 'error'
        ? (controller.errorMessage ?? 'Unable to load')
        : undefined;

  return (
    <section aria-label={`${label} controls`} className="media-preview-controls">
      <div className="media-preview-timeline-row">
        <div className="media-preview-timeline" style={timelineStyle}>
          <span aria-hidden="true" className="media-preview-timeline-buffered" />
          <span aria-hidden="true" className="media-preview-timeline-progress" />
          <input
            aria-label={`Seek ${kind}`}
            aria-valuetext={timeLabel}
            className="media-preview-seek"
            disabled={controller.duration <= 0 || controller.status === 'error'}
            max={controller.duration || 0}
            min={0}
            onChange={(event) => controller.seek(Number(event.currentTarget.value))}
            step={0.1}
            type="range"
            value={controller.currentTime}
          />
        </div>
        <output className="media-preview-time" aria-label={`${label} time`}>
          {timeLabel}
        </output>
      </div>

      <div className="media-preview-control-row">
        <div className="media-preview-control-group">
          <ButtonIcon
            disabled={controller.status === 'error'}
            label={controller.isPlaying ? `Pause ${kind}` : `Play ${kind}`}
            onClick={controller.togglePlayback}
          >
            {controller.isPlaying ? (
              <PauseIcon aria-hidden="true" size={18} />
            ) : (
              <PlayIcon aria-hidden="true" size={18} />
            )}
          </ButtonIcon>
          <ButtonIcon
            label={controller.muted ? `Unmute ${kind}` : `Mute ${kind}`}
            onClick={controller.toggleMute}
            pressed={controller.muted}
          >
            {controller.muted || controller.volume === 0 ? (
              <SpeakerSlashIcon aria-hidden="true" size={18} />
            ) : (
              <SpeakerHighIcon aria-hidden="true" size={18} />
            )}
          </ButtonIcon>
          <input
            aria-label={`${label} volume`}
            className="media-preview-volume"
            max={1}
            min={0}
            onChange={(event) => controller.setVolume(Number(event.currentTarget.value))}
            step={0.01}
            type="range"
            value={controller.muted ? 0 : controller.volume}
          />
        </div>

        <div className="media-preview-control-group media-preview-control-group-end">
          <label className="media-preview-speed">
            <span className="media-preview-speed-label">Speed</span>
            <select
              aria-label={`${label} playback speed`}
              onChange={(event) => controller.setPlaybackRate(Number(event.currentTarget.value))}
              value={controller.playbackRate}
            >
              {PLAYBACK_RATES.map((rate) => (
                <option key={rate} value={rate}>
                  {rate}×
                </option>
              ))}
            </select>
            <CaretDownIcon aria-hidden="true" className="media-preview-speed-icon" size={13} />
          </label>
          {kind === 'video' && onPictureInPicture !== undefined && (
            <ButtonIcon
              disabled={!supportsPictureInPicture}
              label="Picture in picture"
              onClick={onPictureInPicture}
            >
              <PictureInPictureIcon aria-hidden="true" size={18} />
            </ButtonIcon>
          )}
          {kind === 'video' && onFullscreen !== undefined && (
            <ButtonIcon
              disabled={!supportsFullscreen}
              label="Enter fullscreen"
              onClick={onFullscreen}
            >
              <ArrowsOutIcon aria-hidden="true" size={18} />
            </ButtonIcon>
          )}
        </div>
      </div>
      <div aria-live="polite" className="media-preview-status" role="status">
        {statusLabel !== undefined && (
          <>
            {controller.status === 'loading' ? (
              <SpinnerGapIcon aria-hidden="true" className="media-preview-spinner" size={15} />
            ) : (
              <WarningCircleIcon aria-hidden="true" size={15} />
            )}
            <span>{statusLabel}</span>
            {controller.status === 'error' && (
              <button className="media-preview-retry" onClick={controller.reload} type="button">
                Try again
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function mediaClassName(className: string | undefined, kind: 'audio' | 'video'): string {
  return ['media-preview', `media-preview-player-${kind}`, className].filter(Boolean).join(' ');
}

export function AudioPreview({
  src,
  title = 'Audio preview',
  className,
  captions,
  initialVolume,
  initialPlaybackRate,
  showFileIdentity = true,
}: AudioPreviewProps) {
  const controller = useMediaController(src, initialVolume, initialPlaybackRate);
  return (
    <section
      aria-label={title}
      className={mediaClassName(className, 'audio')}
      onKeyDown={controller.onKeyDown}
      tabIndex={0}
    >
      <audio
        aria-label={title}
        className="media-preview-native"
        onCanPlay={controller.onCanPlay}
        onDurationChange={controller.onDurationChange}
        onEnded={controller.onEnded}
        onError={controller.onError}
        onLoadedMetadata={controller.onLoadedMetadata}
        onPause={controller.onPause}
        onPlay={controller.onPlay}
        onProgress={controller.onProgress}
        onTimeUpdate={controller.onTimeUpdate}
        onWaiting={controller.onWaiting}
        preload="metadata"
        ref={controller.mediaRef as React.RefObject<HTMLAudioElement | null>}
        src={src}
      >
        {captions !== undefined && (
          <track
            default={captions.default}
            kind="captions"
            label={captions.label}
            src={captions.src}
            srcLang={captions.srcLang}
          />
        )}
      </audio>
      <AudioMediaControls
        controller={controller}
        label={title}
        showFileIdentity={showFileIdentity}
      />
    </section>
  );
}

function getPictureInPictureVideo(video: HTMLVideoElement): {
  requestPictureInPicture?: () => Promise<unknown>;
} {
  return video as HTMLVideoElement & { requestPictureInPicture?: () => Promise<unknown> };
}

export function VideoPreview({
  src,
  title = 'Video preview',
  className,
  captions,
  poster,
  nativeControls = false,
  aspectRatio = 16 / 9,
  initialVolume,
  initialPlaybackRate,
}: VideoPreviewProps) {
  const controller = useMediaController(src, initialVolume, initialPlaybackRate);
  const videoShellRef = useRef<HTMLDivElement | null>(null);
  const [videoAspectRatio, setVideoAspectRatio] = useState(aspectRatio);
  const [supportsFullscreen, setSupportsFullscreen] = useState(true);
  const [supportsPictureInPicture, setSupportsPictureInPicture] = useState(true);

  useEffect(() => {
    const shell = videoShellRef.current;
    const video = controller.mediaRef.current as HTMLVideoElement | null;
    setSupportsFullscreen(shell !== null && typeof shell.requestFullscreen === 'function');
    setSupportsPictureInPicture(
      video !== null &&
        typeof getPictureInPictureVideo(video).requestPictureInPicture === 'function',
    );

    const onFullscreenChange = () => {
      if (shell === null) return;
      shell.dataset.fullscreen = document.fullscreenElement === shell ? 'true' : 'false';
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [controller.mediaRef]);

  const onMetadata = (event: SyntheticEvent<HTMLMediaElement>) => {
    controller.onLoadedMetadata(event);
    const video = event.currentTarget as HTMLVideoElement;
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setVideoAspectRatio(video.videoWidth / video.videoHeight);
    }
  };

  const onFullscreen = () => {
    const shell = videoShellRef.current;
    if (shell === null || typeof shell.requestFullscreen !== 'function') return;
    if (document.fullscreenElement === shell) {
      void document.exitFullscreen?.();
    } else {
      void shell.requestFullscreen().catch(() => undefined);
    }
  };

  const onPictureInPicture = () => {
    const video = controller.mediaRef.current as HTMLVideoElement | null;
    const pictureInPictureVideo = video === null ? undefined : getPictureInPictureVideo(video);
    if (pictureInPictureVideo?.requestPictureInPicture === undefined) return;
    void pictureInPictureVideo.requestPictureInPicture().catch(() => undefined);
  };

  return (
    <section
      aria-label={title}
      className={mediaClassName(className, 'video')}
      onKeyDown={controller.onKeyDown}
      tabIndex={0}
    >
      <div
        className="media-preview-video-shell"
        ref={videoShellRef}
        style={{ '--media-aspect-ratio': videoAspectRatio } as CSSProperties}
      >
        <video
          aria-label={title}
          className="media-preview-video"
          controls={nativeControls}
          onCanPlay={controller.onCanPlay}
          onDurationChange={controller.onDurationChange}
          onEnded={controller.onEnded}
          onError={controller.onError}
          onLoadedMetadata={onMetadata}
          onPause={controller.onPause}
          onPlay={controller.onPlay}
          onProgress={controller.onProgress}
          onTimeUpdate={controller.onTimeUpdate}
          onWaiting={controller.onWaiting}
          playsInline
          poster={poster}
          preload="metadata"
          ref={controller.mediaRef as React.RefObject<HTMLVideoElement | null>}
          src={src}
        >
          {captions !== undefined && (
            <track
              default={captions.default}
              kind="captions"
              label={captions.label}
              src={captions.src}
              srcLang={captions.srcLang}
            />
          )}
        </video>
      </div>
      <MediaControls
        controller={controller}
        kind="video"
        label={title}
        onFullscreen={onFullscreen}
        onPictureInPicture={onPictureInPicture}
        supportsFullscreen={supportsFullscreen}
        supportsPictureInPicture={supportsPictureInPicture}
      />
    </section>
  );
}
