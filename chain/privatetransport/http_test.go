package privatetransport

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestBoundedReadRetry(t *testing.T) {
	calls := 0
	value, err := RetryRead(context.Background(), func() (int, error) {
		calls++
		if calls < 3 {
			return 0, io.EOF
		}
		return 7, nil
	})
	if value != 7 || err != nil || calls != 3 {
		t.Fatal("transient read recovery", value, err, calls)
	}
	calls = 0
	_, err = RetryRead(context.Background(), func() (int, error) { calls++; return 0, io.ErrUnexpectedEOF })
	if err == nil || calls != 3 {
		t.Fatal("unbounded read attempts", calls)
	}
	calls = 0
	_, err = RetryRead(context.Background(), func() (int, error) { calls++; return 0, errors.New("invalid proof") })
	if err == nil || calls != 1 {
		t.Fatal("non-transient failure retried")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	calls = 0
	_, err = RetryRead(ctx, func() (int, error) { calls++; return 0, io.EOF })
	if err == nil || calls != 1 {
		t.Fatal("cancelled read retried")
	}
}

func TestFailClosedConfiguration(t *testing.T) {
	for _, row := range [][2]string{{"http://example.onion", ""}, {"http://example.onion", "localhost:9050"}, {"http://example.onion", "192.0.2.1:9050"}, {"http://a:b@example.onion", "127.0.0.1:9050"}, {"http://example.onion/admin", "127.0.0.1:9050"}, {"http://example.onion?secret=1", "127.0.0.1:9050"}} {
		if _, err := Client(row[0], row[1]); err == nil {
			t.Fatalf("accepted %v", row)
		}
	}
	client, err := Client("http://127.0.0.1:1", "")
	if err != nil || client.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("environment proxy inheritance")
	}
}

func TestSOCKSRemoteDNSAndRedirectRefusal(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	result := make(chan error, 1)
	go func() {
		conn, e := listener.Accept()
		if e != nil {
			result <- e
			return
		}
		defer conn.Close()
		conn.SetDeadline(time.Now().Add(5 * time.Second))
		greeting := make([]byte, 3)
		if _, e = io.ReadFull(conn, greeting); e != nil {
			result <- e
			return
		}
		conn.Write([]byte{5, 0})
		request := make([]byte, 5)
		if _, e = io.ReadFull(conn, request); e != nil {
			result <- e
			return
		}
		if request[0] != 5 || request[1] != 1 || request[3] != 3 {
			result <- io.ErrUnexpectedEOF
			return
		}
		name := make([]byte, int(request[4])+2)
		if _, e = io.ReadFull(conn, name); e != nil {
			result <- e
			return
		}
		if string(name[:len(name)-2]) != "unresolvable.invalid" {
			result <- io.ErrUnexpectedEOF
			return
		}
		conn.Write([]byte{5, 0, 0, 1, 127, 0, 0, 1, 0, 80})
		_, e = http.ReadRequest(bufio.NewReader(conn))
		if e == nil {
			_, e = io.WriteString(conn, "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
		}
		result <- e
	}()
	client, err := Client("http://unresolvable.invalid", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.Get("http://unresolvable.invalid")
	if err == nil || !strings.Contains(err.Error(), "redirects refused") {
		t.Fatal("redirect was accepted", err)
	}
	if err = <-result; err != nil {
		t.Fatal(err)
	}
}

func TestSOCKSFailureNeverFallsBack(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, e := listener.Accept()
		if e == nil {
			defer conn.Close()
			io.Copy(io.Discard, conn)
		}
	}()
	client, err := Client("http://127.0.0.1:1", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:1", nil)
	if _, err = client.Do(request); err == nil || !strings.Contains(err.Error(), "deadline exceeded") {
		t.Fatal("blocked proxy did not fail closed", err)
	}
}
