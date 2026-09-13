from app.field_processor import process_field
from app.problems import build_instance
from app.simulator import analog_cim, analog_volume, digital_search


def test_planted_cut_analog_finds_strong_cut():
    inst = build_instance("planted_cut", 16, seed=4)
    analog = analog_cim(inst, steps=360, seed=2, noise=0.02)
    planted = inst.cut_value(inst.planted_spins)
    assert analog.cuts[-1] > 0
    assert analog.cuts.max() >= 0.72 * planted
    assert analog.cuts.max() <= inst.max_possible_cut() + 1e-9
    assert planted <= inst.max_possible_cut() + 1e-9


def test_digital_metropolis_updates_one_spin_path():
    inst = build_instance("erdos_renyi", 12, seed=1)
    digital = digital_search(inst, method="metropolis", steps=60, seed=0)
    assert digital.spins_over_time.shape == (60, 12)
    assert digital.updates == 60
    assert digital.configs_examined == 60


def test_digital_greedy_improves_cut():
    inst = build_instance("planted_cut", 16, seed=4)
    digital = digital_search(inst, method="greedy", steps=16 * 12, seed=1)
    assert digital.cuts[-1] >= digital.cuts[0]
    assert digital.cuts[-1] > 0.4 * inst.max_possible_cut()


def test_brute_force_enumerates_half_space():
    inst = build_instance("ring_chords", 8, seed=0)
    digital = digital_search(inst, method="brute")
    assert digital.exhausted
    assert digital.configs_examined == 2 ** 7


def test_analog_volume_counts_parallel_couplings():
    stats = analog_volume(10, 100)
    assert stats["pairwise_couplings"] == 100
    assert stats["equivalent_serial_ops"] == (100 + 30) * 100


def test_field_processor_shapes():
    result = process_field(size=24, gamma=1.5, pattern="two_beams")
    assert result.input_intensity.shape == (24, 24)
    assert result.output_intensity.shape == (24, 24)
    assert result.analog_parallel_ops == 24 * 24
    assert result.digital_flops > result.analog_parallel_ops
