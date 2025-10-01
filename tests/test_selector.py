from backend.matcher.resume_selector import select_best_resume


def test_selector_basic():
    jd = "React developer with AWS and Docker"
    resumes = [
        {"id": "r1", "text": "Java Spring Boot SQL"},
        {"id": "r2", "text": "React Next.js AWS Docker CI/CD"},
    ]
    best, ranking = select_best_resume(jd, resumes)
    assert best["id"] == "r2"
    assert ranking and ranking[0][0] == "r2"
