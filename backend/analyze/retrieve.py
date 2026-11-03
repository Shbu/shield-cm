import math
import re
from collections import Counter

_WORD = re.compile(r"[a-z0-9]+")
_cache = {}


def _tokens(text):
    words = _WORD.findall(text.lower())
    return words + [a + "_" + b for a, b in zip(words, words[1:])]


def _vector(tokens, idf):
    vec = {t: (1 + math.log(c)) * idf.get(t, 0.0) for t, c in Counter(tokens).items()}
    norm = math.sqrt(sum(v * v for v in vec.values())) or 1.0
    return {t: v / norm for t, v in vec.items() if v}


def pool_of(incidents):
    """Synthetic incidents; the real-world ones are already in the static prompt prefix."""
    return [i for i in incidents["incidents"] if i.get("kind", "real") != "real"]


def _index(incidents):
    if _cache.get("source") is not incidents:
        pool = pool_of(incidents)
        docs = [_tokens(inc["summary"]) for inc in pool]
        df = Counter(t for doc in docs for t in set(doc))
        idf = {t: math.log((len(docs) + 1) / (c + 1)) + 1 for t, c in df.items()}
        _cache.update(source=incidents, pool=pool, idf=idf, vectors=[_vector(doc, idf) for doc in docs])
    return _cache


def similar(incidents, text, k, exclude=""):
    """The k pool incidents most similar to `text` by TF-IDF cosine; `exclude` holds one name out for evaluation."""
    idx = _index(incidents)
    if k <= 0 or not idx["pool"]:
        return []
    query = _vector(_tokens(text), idx["idf"])
    scored = sorted(((sum(w * vec.get(t, 0.0) for t, w in query.items()), i)
                     for i, vec in enumerate(idx["vectors"])), reverse=True)
    return [idx["pool"][i] for _, i in scored if idx["pool"][i]["name"] != exclude][:k]
