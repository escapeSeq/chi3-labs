from app.physics import (
    Tone,
    field_from_tones,
    kerr_slice,
    polarize,
    probe,
    saturate,
    sine_harmonics,
    superposition_error,
    time_axis,
)
import numpy as np


def test_superposition_holds_when_linear():
    t = time_axis()
    e1 = field_from_tones(t, [Tone(1.0, 1.0)])
    e2 = field_from_tones(t, [Tone(0.7, 1.625)])
    p1 = polarize(e1, 1.1, 0.0, 0.0)
    p2 = polarize(e2, 1.1, 0.0, 0.0)
    both = polarize(e1 + e2, 1.1, 0.0, 0.0)
    assert np.allclose(both, p1 + p2)


def test_superposition_fails_when_quadratic():
    tones = [Tone(1.0, 1.0), Tone(0.8, 1.625)]
    err = superposition_error(tones, chi1=1.0, chi2=0.6, chi3=0.0)
    assert err > 0.05


def test_superposition_fails_when_cubic():
    tones = [Tone(1.0, 1.0), Tone(0.8, 1.625)]
    err = superposition_error(tones, chi1=1.0, chi2=0.0, chi3=0.4)
    assert err > 0.05


def test_sine_harmonics_match_trig_identities():
    a, chi1, chi2, chi3 = 1.2, 0.9, 0.5, 0.4
    parts = sine_harmonics(a, chi1, chi2, chi3)
    t = time_axis(2048, 8.0)
    field = a * np.sin(2 * np.pi * 1.0 * t)
    response = polarize(field, chi1, chi2, chi3)
    reconstructed = (
        parts["dc"]
        + parts["fund"] * np.sin(2 * np.pi * t)
        - parts["second"] * np.cos(4 * np.pi * t)
        - parts["third"] * np.sin(6 * np.pi * t)
    )
    assert np.allclose(response, reconstructed, atol=1e-10)


def test_linear_probe_has_no_new_frequencies():
    result = probe([Tone(1.1, 1.0)], chi1=1.0, chi2=0.0, chi3=0.0)
    by_order = {peak.order: peak for peak in result.peaks}
    assert "χ²" not in by_order
    assert "χ³" not in by_order
    drive = next(p for p in result.peaks if p.order == "χ¹")
    assert drive.amplitude > 0.5
    # 2ω and 3ω bins should be tiny relative to the drive.
    f = result.freqs
    m = result.mag_response
    drive_mag = m[np.argmin(np.abs(f - 1.0))]
    second = m[np.argmin(np.abs(f - 2.0))]
    third = m[np.argmin(np.abs(f - 3.0))]
    assert second < 0.05 * drive_mag
    assert third < 0.05 * drive_mag
    assert result.superposition_error == 0.0


def test_quadratic_lights_dc_and_second_harmonic():
    result = probe([Tone(1.2, 1.0)], chi1=0.2, chi2=0.8, chi3=0.0)
    labels = {peak.label: peak for peak in result.peaks}
    assert labels["rectification / DC"].amplitude > 0.15
    assert labels["second harmonic 2"].amplitude > 0.15
    third = next((p for p in result.peaks if "third" in p.label), None)
    assert third is None


def test_cubic_lights_third_harmonic():
    result = probe([Tone(1.2, 1.0)], chi1=0.4, chi2=0.0, chi3=0.7)
    third = next(p for p in result.peaks if "third harmonic" in p.label)
    assert third.amplitude > 0.08
    dc = next((p for p in result.peaks if p.frequency == 0.0), None)
    assert dc is None


def test_two_tone_quadratic_makes_sum_and_difference():
    result = probe(
        [Tone(1.0, 1.0), Tone(0.9, 1.625)],
        chi1=0.3,
        chi2=0.85,
        chi3=0.0,
    )
    labels = {peak.label for peak in result.peaks}
    assert "sum frequency" in labels
    assert "difference frequency" in labels
    sum_peak = next(p for p in result.peaks if p.label == "sum frequency")
    diff_peak = next(p for p in result.peaks if p.label == "difference frequency")
    assert sum_peak.amplitude > 0.08
    assert diff_peak.amplitude > 0.08
    assert result.superposition_error > 0.05


def test_kerr_phase_tracks_intensity():
    dark = kerr_slice(n2=0.0)
    bright = kerr_slice(n2=1.6)
    assert np.allclose(dark.phase, 0.0)
    assert bright.phase.max() > 0.5
    # Peak phase sits on the intensity peak (beam center).
    assert np.argmax(bright.phase) == np.argmax(bright.intensity)
    assert not np.allclose(bright.carrier, bright.linear_carrier)


def test_saturate_below_threshold_dies():
    trace = saturate(pump=0.4, chi3=1.0, x0=0.5)
    assert abs(trace.x[-1]) < 0.05
    assert trace.wells == (0.0,)
    assert not trace.runaway


def test_saturate_above_threshold_locks_to_well():
    trace = saturate(pump=1.69, chi3=1.0, x0=0.08)
    well = np.sqrt(0.69)
    assert abs(abs(trace.x[-1]) - well) < 0.05
    assert len(trace.wells) == 2
    assert not trace.runaway


def test_saturate_without_cubic_runs_away():
    trace = saturate(pump=1.7, chi3=0.0, x0=0.08)
    assert trace.runaway
    assert abs(trace.x[-1]) > 10
    assert "runs away" in trace.lesson
