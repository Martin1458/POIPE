"""Regression checks for overlap detection, EOF handling, and generated timing."""
import unittest

import numpy as np

from analyze_audio import RATE, compare_reference, match_events
from build_yt_preset import build


class AnalysisTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(1234)
        self.template = rng.normal(0, 0.1, round(RATE * 0.4))
        self.template[:round(RATE * 0.03)] = 0

    def test_overlaps_and_truncated_final_sound(self):
        starts = [0.1, 0.5, 0.542, 1.0]
        samples = np.zeros(round(RATE * 1.2))
        for start in starts:
            p = round(start * RATE)
            length = min(len(self.template), len(samples) - p)
            samples[p:p + length] += self.template[:length]
        events, residual = match_events(samples, self.template)
        self.assertEqual(len(events), len(starts))
        for event, start in zip(events, starts):
            self.assertAlmostEqual(event['template_start_seconds'], start, places=4)
        self.assertTrue(events[-1]['truncated'])
        self.assertLess(residual, 0.01)

    def test_silence_has_no_events(self):
        events, _ = match_events(np.zeros(RATE), self.template)
        self.assertEqual(events, [])

    def test_speed_and_gain_comparison(self):
        example = np.pad(self.template * 0.7, (round(RATE * 0.1), round(RATE * 0.1)))
        result = compare_reference(example, self.template, 0.99, 1.01)
        self.assertEqual(result['speed_percent'], 100)
        self.assertAlmostEqual(result['rms_gain_percent'], 70, delta=1)

    def test_preset_preserves_measured_distribution(self):
        report = {'intervals_seconds': [943.15, 0.042, 2.2, 180],
                  'duration_seconds': 3603.6, 'sha256': 'test',
                  'reference_comparison': {'rms_gain_percent': 102.1, 'speed_percent': 100}}
        result = build(report)
        self.assertEqual(result['settings']['volume'], 100)
        self.assertEqual(result['settings']['duration'], 60)
        self.assertEqual(result['settings']['minInterval'], 0)
        self.assertEqual(result['settings']['maxInterval'], 944)
        self.assertEqual(result['intervalsSeconds'], sorted(report['intervals_seconds']))
        self.assertEqual(result['settings']['curve'], 'ytVideo')


if __name__ == '__main__':
    unittest.main()
