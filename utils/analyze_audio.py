#!/usr/bin/env python3
"""Find repeated sounds in a sparse recording using FFmpeg and template matching."""
import argparse
import csv
import hashlib
import json
import re
import subprocess
from pathlib import Path

import numpy as np
from scipy import signal

ROOT = Path(__file__).resolve().parents[1]
RATE = 24000


def run(*args):
    return subprocess.run(args, check=True, capture_output=True)


def duration(path):
    return float(run('ffprobe', '-v', 'error', '-show_entries',
                     'format=duration', '-of', 'csv=p=0', str(path)).stdout)


def decode(path, start=0, length=None, rate=RATE):
    args = ['ffmpeg', '-v', 'error', '-ss', str(start), '-i', str(path)]
    if length is not None:
        args += ['-t', str(length)]
    raw = run(*args, '-ac', '1', '-ar', str(rate), '-f', 'f32le', '-').stdout
    return np.frombuffer(raw, dtype='<f4').astype(np.float64)


def audible_regions(path, total, threshold, silence):
    log = run('ffmpeg', '-hide_banner', '-nostats', '-i', str(path), '-af',
              f'silencedetect=noise={threshold}dB:d={silence}', '-f', 'null', '-').stderr.decode()
    regions, cursor = [], 0.0
    for kind, value in re.findall(r'silence_(start|end): ([\d.]+)', log):
        value = min(float(value), total)
        if kind == 'start' and value > cursor:
            regions.append((cursor, value))
        elif kind == 'end':
            cursor = value
    # A silence_start without a subsequent silence_end means the file ends silently.
    markers = re.findall(r'silence_(start|end): ([\d.]+)', log)
    if not markers or markers[-1][0] == 'end':
        if total - cursor > 0.02:
            regions.append((cursor, total))
    return regions


def match_events(samples, template, min_gain=0.5, min_correlation=0.2):
    """Match overlapping copies; account for a final copy cut off by EOF.

    Gain is relative to the recording's own isolated example. Requiring both
    gain and correlation rejects the example's autocorrelation side lobes.
    A 30 ms separation still resolves the rapid repeats near the end of YT.mp3.
    """
    n, m = len(samples), len(template)
    padded = np.pad(samples, (0, m))
    dots = signal.correlate(padded, template, mode='valid', method='fft')[:n]
    energy = signal.convolve(padded ** 2, np.ones(m), mode='valid', method='fft')[:n]
    template_energy = np.r_[0, np.cumsum(template ** 2)]
    visible_energy = template_energy[np.minimum(m, n - np.arange(n))]
    fraction = visible_energy / template_energy[-1]
    gain = dots / np.maximum(visible_energy, 1e-12)
    correlation = dots / np.sqrt(np.maximum(energy * visible_energy, 1e-12))
    eligible = (fraction >= 0.1) & (gain >= min_gain) & (correlation >= min_correlation)
    scores = np.where(eligible, gain, 0)
    peaks, _ = signal.find_peaks(scores, height=min_gain, distance=round(RATE * 0.03))
    events = []
    reconstruction = np.zeros_like(samples)
    for p in peaks:
        p = int(p)
        visible = min(m, n - p)
        reconstruction[p:p + visible] += gain[p] * template[:visible]
        events.append({'template_start_seconds': p / RATE,
                       'relative_gain': round(float(gain[p]), 4),
                       'correlation': round(float(correlation[p]), 4),
                       'truncated': bool(visible < m)})
    residual = np.sum((samples - reconstruction) ** 2) / max(np.sum(samples ** 2), 1e-12)
    return events, float(residual)


def compare_reference(example, reference, speed_min, speed_max):
    # Downsample only this speed search; event timing uses 24 kHz above.
    example = signal.resample_poly(example, 1, 3)
    reference = signal.resample_poly(reference, 1, 3)
    best = None
    for speed in np.arange(speed_min, speed_max + 0.0005, 0.001):
        template = signal.resample(reference, round(len(reference) / speed))
        if len(template) > len(example):
            continue
        power = np.sum(template ** 2)
        dots = signal.correlate(example, template, mode='valid', method='fft')
        energy = signal.convolve(example ** 2, np.ones(len(template)), mode='valid', method='fft')
        correlations = dots / np.sqrt(np.maximum(energy * power, 1e-12))
        p = int(np.argmax(correlations))
        if best is None or correlations[p] > best['correlation']:
            best = {'speed_percent': round(float(speed * 100), 1),
                    'correlation': float(correlations[p]),
                    'rms_gain_percent': round(float(np.sqrt(energy[p] / power) * 100), 1)}
    if best is None:
        raise ValueError('The isolated example is too short for the reference/speed range.')
    best['correlation'] = round(best['correlation'], 4)
    return best


def summarize(values):
    return {name: round(float(value), 6) for name, value in zip(
        ['min', 'median', 'mean', 'max'],
        [np.min(values), np.median(values), np.mean(values), np.max(values)])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('audio', nargs='?', type=Path, default=ROOT / 'YT.mp3')
    parser.add_argument('--reference', type=Path, default=ROOT / 'POIPE.wav')
    parser.add_argument('--output', type=Path, default=ROOT / 'utils/yt-analysis.json')
    parser.add_argument('--threshold-db', type=float, default=-40)
    parser.add_argument('--silence-seconds', type=float, default=0.3)
    parser.add_argument('--min-gain', type=float, default=0.5)
    parser.add_argument('--min-correlation', type=float, default=0.2)
    parser.add_argument('--speed-min', type=float, default=0.75)
    parser.add_argument('--speed-max', type=float, default=1.25)
    args = parser.parse_args()
    if not (0 < args.speed_min <= args.speed_max) or args.silence_seconds <= 0:
        parser.error('Speeds and silence duration must be positive; speed min must be <= max.')
    total = duration(args.audio)
    reference = decode(args.reference)
    regions = audible_regions(args.audio, total, args.threshold_db, args.silence_seconds)
    ref_duration = len(reference) / RATE
    # Use the first complete, plausibly isolated sound as an in-recording template.
    candidates = [(a, b) for a, b in regions
                  if 0.7 * ref_duration <= b - a <= 1.3 * ref_duration and b < total - 0.1]
    if not candidates:
        raise ValueError('No isolated reference-length sound found; inspect silence thresholds.')
    first_start, first_end = candidates[0]
    template_start = max(0, first_start - 0.15)
    template = decode(args.audio, template_start, first_end - template_start + 0.15)
    onset_offset = first_start - template_start
    comparison_example = decode(args.audio, max(0, first_start - 0.5), first_end - first_start + 1)
    comparison = compare_reference(comparison_example, reference, args.speed_min, args.speed_max)
    events, region_reports = [], []
    for start, end in regions:
        offset = max(0, start - 0.5)
        samples = decode(args.audio, offset, end - offset + 0.5)
        matches, residual = match_events(samples, template, args.min_gain, args.min_correlation)
        for match in matches:
            onset = offset + match.pop('template_start_seconds') + onset_offset
            if start - 0.1 <= onset <= end:
                events.append({'onset_seconds': round(onset, 6), **match})
        region_reports.append({'start_seconds': start, 'end_seconds': end,
                               'matched_events': sum(start - 0.1 <= e['onset_seconds'] <= end for e in events),
                               'residual_energy_fraction': round(residual, 4)})
    events.sort(key=lambda event: event['onset_seconds'])
    if len(events) < 2:
        raise ValueError('Fewer than two matches; cannot estimate an interval distribution.')
    intervals = np.diff([event['onset_seconds'] for event in events])
    report = {
        'audio': args.audio.name,
        'sha256': hashlib.sha256(args.audio.read_bytes()).hexdigest(),
        'duration_seconds': total,
        'reference': args.reference.name,
        'settings': {'sample_rate': RATE, 'threshold_db': args.threshold_db,
                     'silence_seconds': args.silence_seconds, 'min_gain': args.min_gain,
                     'min_correlation': args.min_correlation, 'speed_min': args.speed_min,
                     'speed_max': args.speed_max},
        'template': {'start_seconds': template_start, 'end_seconds': first_end + 0.15},
        'reference_comparison': comparison,
        'regions': region_reports, 'events': events,
        'intervals_seconds': np.round(intervals, 6).tolist(),
        'interval_summary_seconds': summarize(intervals),
        'notes': [
            'Onsets use the audible start of the isolated example, not the beginning of POIPE.wav.',
            'Intervals are onset-to-onset, matching the website scheduler; leading/trailing silence is excluded.',
            'Template matching finds overlapping copies but can miss altered or heavily masked sounds.',
            'High residual energy flags material not explained by the matched copies; event count is an estimate.',
            'RMS gain compares mono decoded signals; compression and waveform differences limit loudness accuracy.',
            'Relative gains below one can reflect sub-sample alignment and MP3 encoding, not intentional volume variation.'
        ]
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    with args.output.with_suffix('.csv').open('w', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(events[0]))
        writer.writeheader()
        writer.writerows(events)
    print(json.dumps({key: report[key] for key in [
        'duration_seconds', 'reference_comparison', 'interval_summary_seconds']}, indent=2))
    print(f'{len(events)} estimated plays in {len(regions)} audible regions. Report: {args.output}')


if __name__ == '__main__':
    main()
