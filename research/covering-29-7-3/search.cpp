#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <fstream>
#include <iostream>
#include <random>
#include <vector>
using namespace std;
int ids[29][29][29],ct[3654];array<int,3> triples[3654];
vector<int> ts(uint32_t mask){vector<int>a,v;for(int i=0;i<29;i++)if(mask>>i&1)a.push_back(i);for(int i=0;i<7;i++)for(int j=i+1;j<7;j++)for(int k=j+1;k<7;k++)v.push_back(ids[a[i]][a[j]][a[k]]);return v;}
int main(int argc,char**argv){unsigned seed=argc>1?stoul(argv[1]):1;int seconds=argc>2?stoi(argv[2]):300;mt19937 rng(seed);int n=0;for(int i=0;i<29;i++)for(int j=i+1;j<29;j++)for(int k=j+1;k<29;k++){ids[i][j][k]=n;triples[n++]={i,j,k};}vector<uint32_t>b(130);vector<vector<int>>bt(130);for(int i=0;i<130;i++){uint32_t m=0;while(__builtin_popcount(m)<7)m|=1u<<(rng()%29);b[i]=m;bt[i]=ts(m);for(int t:bt[i])ct[t]++;}int cost=0,best=3654;for(int i=0;i<n;i++)cost+=ct[i]==0;auto begin=chrono::steady_clock::now();long long it=0;for(;;it++){if(it%4096==0&&chrono::duration<double>(chrono::steady_clock::now()-begin).count()>seconds)break;vector<int>missing;for(int t=0;t<n;t++)if(ct[t]==0)missing.push_back(t);if(missing.empty()){cerr<<"FOUND\n";break;}int t=missing[rng()%missing.size()];uint32_t target=0;for(int x:triples[t])target|=1u<<x;int rb=-1,delta=999;uint32_t nm=0;vector<int>nt;for(int tries=0;tries<80;tries++){int row=rng()%130;if(__builtin_popcount(b[row]&target)!=2)continue;uint32_t absent=target&~b[row],rem=b[row]&~target;int choice=rng()%__builtin_popcount(rem);while(choice--)rem&=rem-1;rem&=-rem;uint32_t m=(b[row]&~rem)|absent;auto v=ts(m);int d=0;for(int x:bt[row])if(ct[x]==1)d++;for(int x:v){bool old=find(bt[row].begin(),bt[row].end(),x)!=bt[row].end();if(ct[x]-(old?1:0)==0)d--;}if(d<delta){rb=row;delta=d;nm=m;nt=move(v);}}double phase=(it%200000)/200000.0,temp=0.12+0.7*(1-phase);if(rb>=0&&(delta<=0||generate_canonical<double,32>(rng)<exp(-delta/temp))){for(int x:bt[rb])ct[x]--;for(int x:nt)ct[x]++;b[rb]=nm;bt[rb]=move(nt);cost+=delta;}if(cost<best){best=cost;cerr<<"seed="<<seed<<" iterations="<<it<<" missing="<<best<<"\n";ofstream out("best-"+to_string(seed)+".txt");for(auto m:b){bool sep=false;for(int i=0;i<29;i++)if(m>>i&1){if(sep)out<<' ';out<<i;sep=true;}out<<'\n';}if(best==0)break;}}cerr<<"FINAL seed="<<seed<<" iterations="<<it<<" missing="<<best<<"\n";return best==0?0:2;}
