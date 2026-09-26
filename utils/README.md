# YouTube audio analysis

These offline Python tools analyze `YT.mp3` and generate the **that YT video**
preset. The website still plays `POIPE.wav`; it does not download or play the MP3.
No Python or FFmpeg is needed to run the website.

## Run

Requires Python 3.9+ and `ffmpeg`/`ffprobe` on your PATH.
From the project root:

```sh
python3 -m venv utils/.venv
utils/.venv/bin/python -m pip install -r utils/requirements.txt
OPENBLAS_NUM_THREADS=1 utils/.venv/bin/python utils/analyze_audio.py
utils/.venv/bin/python utils/build_yt_preset.py
utils/.venv/bin/python -m unittest discover -s utils -p 'test_*.py'
```

`analyze_audio.py --help` lists input paths and detection thresholds.
It writes `utils/yt-analysis.json` and a CSV of matched onsets. The builder writes
`utils/yt-preset.json` and the browser asset `yt-preset.js`. Commit that generated
JavaScript alongside the website when publishing changes.

## What was measured

The supplied MP3 lasts **3603.61 seconds**. Silence detection finds eight audible
regions. Matching against the first isolated sound identifies **17 likely plays**,
including a final sound cut off by the end of the recording. Sixteen measured
onset-to-onset gaps range from **0.0417 to 943.1505 seconds**, with a median of
**2.3148 seconds** and a mean of **225.1141 seconds**. Nine gaps are shorter than
three seconds; seven exceed one minute.

The first isolated sound's best match to `POIPE.wav` is at **100% speed**. Its mono
RMS level is approximately **102%** of the local sample, rounded to **100% volume**
for the preset. Copies in the isolated sections have nearly constant level;
the preset uses zero volume and pitch variation.

## How the preset uses the measurements

The source alternates long pauses with rapid repeats. A single uniform range would
lose that distinction. The new **YouTube timing (measured gaps)** option samples
the sixteen observed gaps with equal probability, with replacement. This retains
the observed proportion of short and long gaps without repeating the video in a
fixed order. The graph shows probability masses for these discrete gaps.

The preset runs for 60 minutes. Its interval controls are 0–944 seconds; 944 is a
rounded scale bound, while the largest sampled gap is 943.1505 seconds. Changing
the minimum/maximum rescales the measured pattern into the new range. Strength is
hidden because it is not used for this distribution. Minimum zero preserves the
player's existing unlimited-overlap behavior. Selecting another built-in preset
resets its timing curve to uniform. Custom presets can save this timing option.

This is a statistical approximation, not an exact reconstruction. In particular:

- The recording starts its first sound at about 1.4 seconds; the player samples
  its first wait from the same distribution as later waits.
- Independent sampling does not preserve the original order or guarantee the
  same number of sounds per hour.
- Parts of the two busy regions are not explained by clean copies of the isolated
  template. Residual energy is about 45% and 32%, respectively, so altered or masked
  sounds may be missed. The event count and gap distribution are estimates.
- MP3 encoding, fractional sample alignment, and differences between the video's
  sound and `POIPE.wav` limit amplitude/correlation accuracy. Matching scores alone
  should not be interpreted as deliberate volume variation.

## Method

FFmpeg detects silence below −40 dB lasting at least 0.3 seconds. Only audible
regions are decoded into 24 kHz mono arrays. The first complete region of roughly
the reference sound's duration becomes the matching template. Cross-correlation
finds overlapping copies, requiring both a normalized similarity score and a
minimum relative amplitude to reject autocorrelation side lobes. Partial template
energy is used for a sound cut off at EOF. A separate 0.1-percentage-point speed
search compares the isolated example with the local reference.

The report includes source SHA-256, detector settings, match confidence, residual
energy per region, timestamps, and interval statistics. Source leading/trailing
silence is not treated as a complete interval.
