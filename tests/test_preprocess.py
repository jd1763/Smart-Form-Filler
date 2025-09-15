import os
import sys

from ml import preprocess

# Make sure the parent directory is in sys.path
# This lets us import `ml/preprocess.py` even when tests run from project root
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def test_clean_text_basic():
    """
    Test the basic text cleaning function.

    clean_text() should:
    - Lowercase everything
    - Strip punctuation
    - Remove stopwords

    Example:
        "The QUICK brown fox, jumped over THE lazy dog!"
        -> "quick brown fox jumped lazy dog"
    """
    raw = "The QUICK brown fox, jumped over THE lazy dog!"
    cleaned = preprocess.clean_text(raw)

    # Expect meaningful words kept
    assert "quick" in cleaned
    assert "brown" in cleaned
    assert "fox" in cleaned
    assert "lazy" in cleaned
    assert "dog" in cleaned

    # Expect stopword "the" removed
    assert "the" not in cleaned


def test_process_folder(tmp_path):
    """
    Test process_folder() end-to-end.

    Steps:
    - Create a fake input folder with one text file
    - Run process_folder(input, output)
    - Verify that:
        * A cleaned version of the file exists in output
        * It has lowercase + stopwords removed
    """
    # Make fake input + output folders
    input_dir = tmp_path / "input"
    output_dir = tmp_path / "output"
    input_dir.mkdir()
    output_dir.mkdir()

    # Write a sample input file
    input_file = input_dir / "sample.txt"
    input_file.write_text("Hello WORLD! This is a TEST.", encoding="utf-8")

    # Run the cleaning pipeline
    preprocess.process_folder(str(input_dir), str(output_dir))

    # Verify output file was created
    output_file = output_dir / "sample.txt"
    assert output_file.exists()

    # Check contents are cleaned
    cleaned = output_file.read_text(encoding="utf-8")
    assert "hello" in cleaned
    assert "world" in cleaned
    assert "test" in cleaned
    assert "this" not in cleaned  # stopword should be removed
